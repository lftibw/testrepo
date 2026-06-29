/**
 * REST API for dynamically adding picklist values with optional field dependency
 * and record-type availability — implemented via the Tooling API (REST callouts).
 *
 * POST /services/apexrest/picklist-manager/v1/   → add value; returns final result synchronously
 *
 * Why the Tooling API (and NOT the Apex Metadata namespace):
 *   The Apex `Metadata` namespace only supports CustomMetadata records and Layouts.
 *   It does NOT support CustomField or RecordType, so it cannot add picklist values
 *   or field dependencies. The Tooling API's CustomField/RecordType objects, however,
 *   expose a writable `Metadata` field. We GET the current metadata JSON, mutate it,
 *   and PATCH it back — synchronously.
 *
 * Jenkins flow (single, blocking call):
 *   POST  → { "success": true, "status": "Succeeded" }   ← run the job
 *         → { "success": false, "status": "Failed", "errorDetail": [...] }  ← stop
 *
 * Prerequisites:
 *   - Remote Site Setting (or Named Credential) allowing callout to this org's My Domain.
 *   - Running user needs "Customize Application" (or "Modify All Data").
 *   - Querying the Tooling API `Metadata` field requires a single-row result, which the
 *     unique DeveloperName / SobjectType filters guarantee.
 */
@RestResource(urlMapping='/picklist-manager/v1/*')
global with sharing class DynamicPicklistManagerAPI {

    private static final String API_VERSION = 'v62.0';

    // ── Request DTOs ─────────────────────────────────────────────────────────

    global class AddPicklistRequest {
        /** API name of the SObject, e.g. 'Account' */
        global String objectApiName;
        /** API name of the picklist field to update, e.g. 'MSMarketingCategory__c' */
        global String fieldApiName;
        /**
         * Developer name (not label) of the record type the new value must be
         * visible on, e.g. 'Media_Sales'. Pass null to skip record-type scoping.
         */
        global String recordTypeDevName;
        /** API name / stored value of the new picklist entry, e.g. 'Digital_Media' */
        global String picklistValue;
        /** Human-readable label for the new entry, e.g. 'Digital Media' */
        global String picklistLabel;
        /** Set true to make this the default value on the field / record type */
        global Boolean isDefault;
        /**
         * Optional: wire this new dependent value to specific controlling-field values.
         * Omit when no field dependency is needed.
         */
        global DependencyInput dependency;
    }

    global class DependencyInput {
        /** API name of the controlling (parent) picklist field, e.g. 'STO__c' */
        global String controllingFieldApiName;
        /**
         * The exact stored values on the controlling field that should reveal this
         * new dependent value, e.g. ['Online', 'Digital'].
         */
        global List<String> controllingValues;
    }

    // ── Response DTO ─────────────────────────────────────────────────────────

    global class ApiResponse {
        global Boolean      success;
        /** Succeeded | Failed */
        global String       status;
        global String       message;
        global List<String> errorDetail;
    }

    // ── Endpoint ─────────────────────────────────────────────────────────────

    /**
     * Add a picklist value (and optionally a dependency mapping) to a field,
     * making it available on the specified record type. Synchronous.
     *
     * Example body:
     * {
     *   "objectApiName":    "Account",
     *   "fieldApiName":     "MSMarketingCategory__c",
     *   "recordTypeDevName":"Media_Sales",
     *   "picklistValue":    "Digital_Media",
     *   "picklistLabel":    "Digital Media",
     *   "isDefault":        false,
     *   "dependency": {
     *     "controllingFieldApiName": "STO__c",
     *     "controllingValues":       ["Online", "Digital"]
     *   }
     * }
     */
    @HttpPost
    global static ApiResponse addPicklistValue() {
        ApiResponse resp = new ApiResponse();
        resp.errorDetail = new List<String>();
        try {
            AddPicklistRequest req = (AddPicklistRequest) JSON.deserialize(
                RestContext.request.requestBody.toString(),
                AddPicklistRequest.class
            );
            validateRequest(req);

            String baseUrl   = System.URL.getOrgDomainUrl().toExternalForm();
            String sessionId = UserInfo.getSessionId();

            // ── 1. CustomField: read → mutate → patch ────────────────────────
            Map<String, Object> cfRecord = readToolingRecord(
                baseUrl, sessionId, 'CustomField',
                'TableEnumOrId = \'' + req.objectApiName + '\' AND DeveloperName = \'' +
                req.fieldApiName.removeEnd('__c') + '\''
            );
            String cfId = (String) cfRecord.get('Id');
            Map<String, Object> cfMeta = (Map<String, Object>) cfRecord.get('Metadata');

            addValueToCustomField(cfMeta, req);

            patchToolingRecord(
                baseUrl, sessionId, 'CustomField', cfId,
                new Map<String, Object>{ 'Metadata' => cfMeta }
            );

            // ── 2. RecordType (optional): read → mutate → patch ──────────────
            if (String.isNotBlank(req.recordTypeDevName)) {
                Map<String, Object> rtRecord = readToolingRecord(
                    baseUrl, sessionId, 'RecordType',
                    'SobjectType = \'' + req.objectApiName + '\' AND DeveloperName = \'' +
                    req.recordTypeDevName + '\''
                );
                String rtId = (String) rtRecord.get('Id');
                Map<String, Object> rtMeta = (Map<String, Object>) rtRecord.get('Metadata');

                addValueToRecordType(rtMeta, req);

                patchToolingRecord(
                    baseUrl, sessionId, 'RecordType', rtId,
                    new Map<String, Object>{ 'Metadata' => rtMeta }
                );
            }

            resp.success = true;
            resp.status  = 'Succeeded';
            resp.message = buildSuccessMessage(req);

        } catch (DynamicPicklistException e) {
            resp.success = false;
            resp.status  = 'Failed';
            resp.message = e.getMessage();
            resp.errorDetail.add(e.getMessage());
        } catch (Exception e) {
            resp.success = false;
            resp.status  = 'Failed';
            resp.message = 'Unexpected error: ' + e.getMessage();
            resp.errorDetail.add(e.getMessage() + ' @ ' + e.getStackTraceString());
        }
        return resp;
    }

    // ── Tooling API helpers ──────────────────────────────────────────────────

    /**
     * Queries the Tooling API for a single record (Id + Metadata) and returns it
     * as a map. Throws when not found. The single-row filter is required because
     * the Metadata field can only be selected for one row at a time.
     */
    private static Map<String, Object> readToolingRecord(
        String baseUrl, String sessionId, String toolingType, String whereClause
    ) {
        String soql = ('SELECT Id, Metadata FROM ' + toolingType + ' WHERE ' + whereClause)
            .replace(' ', '+').replace('\'', '%27');
        String endpoint = baseUrl + '/services/data/' + API_VERSION + '/tooling/query/?q=' + soql;

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint(endpoint);
        httpReq.setMethod('GET');
        httpReq.setHeader('Authorization', 'Bearer ' + sessionId);
        httpReq.setHeader('Content-Type', 'application/json');
        httpReq.setTimeout(60000);

        HttpResponse httpResp = new Http().send(httpReq);
        if (httpResp.getStatusCode() != 200) {
            throw new DynamicPicklistException(
                'Tooling query failed for ' + toolingType + ': HTTP ' +
                httpResp.getStatusCode() + ' – ' + httpResp.getBody()
            );
        }

        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(httpResp.getBody());
        List<Object> records = (List<Object>) body.get('records');
        if (records == null || records.isEmpty()) {
            throw new DynamicPicklistException(
                toolingType + ' not found for: ' + whereClause
            );
        }
        return (Map<String, Object>) records[0];
    }

    /**
     * PATCHes an updated Metadata payload onto a Tooling API record by Id.
     * Tooling API returns 204 (No Content) on success.
     */
    private static void patchToolingRecord(
        String baseUrl, String sessionId, String toolingType, String recordId,
        Map<String, Object> payload
    ) {
        String endpoint = baseUrl + '/services/data/' + API_VERSION +
            '/tooling/sobjects/' + toolingType + '/' + recordId;

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint(endpoint);
        httpReq.setMethod('PATCH');
        httpReq.setHeader('Authorization', 'Bearer ' + sessionId);
        httpReq.setHeader('Content-Type', 'application/json');
        httpReq.setTimeout(120000);
        httpReq.setBody(JSON.serialize(payload));

        HttpResponse httpResp = new Http().send(httpReq);
        Integer code = httpResp.getStatusCode();
        if (code != 204 && code != 200) {
            throw new DynamicPicklistException(
                'Tooling update failed for ' + toolingType + ': HTTP ' +
                code + ' – ' + httpResp.getBody()
            );
        }
    }

    // ── Metadata mutators (operate on raw JSON maps) ──────────────────────────

    /**
     * Appends the new picklist value to the field's value set, preserving every
     * existing value and dependency setting. Adds a valueSettings entry when a
     * dependency is supplied.
     */
    private static void addValueToCustomField(Map<String, Object> cfMeta, AddPicklistRequest req) {
        Map<String, Object> vs = (Map<String, Object>) cfMeta.get('valueSet');
        if (vs == null) {
            throw new DynamicPicklistException(
                req.fieldApiName + ' is not a custom value-set picklist (no valueSet metadata).'
            );
        }

        // Set controllingField only if a dependency is requested and none exists yet.
        if (req.dependency != null) {
            Object existingCtrl = vs.get('controllingField');
            if (existingCtrl == null || String.isBlank(String.valueOf(existingCtrl))) {
                vs.put('controllingField', req.dependency.controllingFieldApiName);
            }
        }

        Map<String, Object> vsd = (Map<String, Object>) vs.get('valueSetDefinition');
        if (vsd == null) {
            throw new DynamicPicklistException(
                req.fieldApiName + ' uses a global value set; values must be managed on the global set, not the field.'
            );
        }

        List<Object> values = (List<Object>) vsd.get('value');
        if (values == null) {
            values = new List<Object>();
            vsd.put('value', values);
        }

        // Reject duplicates.
        for (Object o : values) {
            Map<String, Object> existing = (Map<String, Object>) o;
            if (req.picklistValue.equals(existing.get('fullName'))) {
                throw new DynamicPicklistException(
                    'Picklist value already exists: ' + req.picklistValue
                );
            }
        }

        values.add(new Map<String, Object>{
            'fullName' => req.picklistValue,
            'label'    => String.isNotBlank(req.picklistLabel) ? req.picklistLabel : req.picklistValue,
            'default'  => req.isDefault == true,
            'isActive' => true
        });

        // Dependency mapping.
        if (req.dependency != null) {
            List<Object> settings = (List<Object>) vs.get('valueSettings');
            if (settings == null) {
                settings = new List<Object>();
                vs.put('valueSettings', settings);
            }
            settings.add(new Map<String, Object>{
                'valueName'             => req.picklistValue,
                'controllingFieldValue' => req.dependency.controllingValues
            });
        }
    }

    /**
     * Makes the new value available on the target record type, preserving all
     * existing record-type picklist availability.
     */
    private static void addValueToRecordType(Map<String, Object> rtMeta, AddPicklistRequest req) {
        List<Object> picklistValues = (List<Object>) rtMeta.get('picklistValues');
        if (picklistValues == null) {
            picklistValues = new List<Object>();
            rtMeta.put('picklistValues', picklistValues);
        }

        Map<String, Object> newEntry = new Map<String, Object>{
            'fullName' => req.picklistValue,
            'default'  => req.isDefault == true
        };

        Boolean attached = false;
        for (Object o : picklistValues) {
            Map<String, Object> plv = (Map<String, Object>) o;
            if (req.fieldApiName.equals(plv.get('picklist'))) {
                List<Object> vals = (List<Object>) plv.get('values');
                if (vals == null) {
                    vals = new List<Object>();
                    plv.put('values', vals);
                }
                vals.add(newEntry);
                attached = true;
                break;
            }
        }

        if (!attached) {
            picklistValues.add(new Map<String, Object>{
                'picklist' => req.fieldApiName,
                'values'   => new List<Object>{ newEntry }
            });
        }
    }

    // ── Validation & messaging ────────────────────────────────────────────────

    private static void validateRequest(AddPicklistRequest req) {
        List<String> errors = new List<String>();
        if (String.isBlank(req.objectApiName)) errors.add('objectApiName is required');
        if (String.isBlank(req.fieldApiName))  errors.add('fieldApiName is required');
        if (String.isBlank(req.picklistValue)) errors.add('picklistValue is required');
        if (req.dependency != null) {
            if (String.isBlank(req.dependency.controllingFieldApiName)) {
                errors.add('dependency.controllingFieldApiName is required when dependency is provided');
            }
            if (req.dependency.controllingValues == null || req.dependency.controllingValues.isEmpty()) {
                errors.add('dependency.controllingValues must not be empty when dependency is provided');
            }
        }
        if (!errors.isEmpty()) {
            throw new DynamicPicklistException(String.join(errors, '; '));
        }
    }

    private static String buildSuccessMessage(AddPicklistRequest req) {
        String msg = 'Added picklist value "' + req.picklistValue + '" to ' +
            req.objectApiName + '.' + req.fieldApiName;
        if (req.dependency != null) {
            msg += '; dependent on ' + req.dependency.controllingFieldApiName +
                ' values ' + req.dependency.controllingValues;
        }
        if (String.isNotBlank(req.recordTypeDevName)) {
            msg += '; available on record type ' + req.recordTypeDevName;
        }
        return msg + '.';
    }

    global class DynamicPicklistException extends Exception {}
}
