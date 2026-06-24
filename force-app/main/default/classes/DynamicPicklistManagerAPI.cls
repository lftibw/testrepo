/**
 * REST API for dynamically adding picklist values with optional field dependency.
 *
 * POST  /services/apexrest/picklist-manager/v1/          → add value, returns deploymentId
 * GET   /services/apexrest/picklist-manager/v1/          → poll status, pass ?deploymentId=xxx
 *
 * Jenkins usage pattern:
 *   1. POST  → capture deploymentId
 *   2. GET   (poll every ~10s) until status == "Succeeded" or "Failed"
 *
 * Prerequisites:
 *   - Remote Site Setting (or Named Credential) allowing callout to your own org domain.
 *   - Running user must have "Modify All Data" or "Customize Application" permission.
 *
 * Constraints (Salesforce platform):
 *   - Deployment is asynchronous; Succeeded/Failed comes via polling (GET endpoint).
 *   - Callouts cannot happen after DML in the same transaction, so the Tooling API
 *     reads (callouts) happen first, then enqueueDeployment (DML) last.
 */
@RestResource(urlMapping='/picklist-manager/v1/*')
global with sharing class DynamicPicklistManagerAPI {

    // ── Request DTOs ─────────────────────────────────────────────────────────

    global class AddPicklistRequest {
        /** API name of the SObject, e.g. 'Account' */
        global String objectApiName;
        /** API name of the picklist field to update, e.g. 'MSMarketingCategory__c' */
        global String fieldApiName;
        /**
         * Developer name (not label) of the record type the new value must be
         * visible on, e.g. 'Media_Sales'.  Pass null to skip record-type scoping.
         */
        global String recordTypeDevName;
        /** API name / stored value of the new picklist entry, e.g. 'Digital_Media' */
        global String picklistValue;
        /** Human-readable label for the new entry, e.g. 'Digital Media' */
        global String picklistLabel;
        /** Set true to make this the default value on the field */
        global Boolean isDefault;
        /**
         * Optional: wire this new dependent value to specific controlling-field values.
         * Omit (leave null) when no field dependency is needed, or when the controlling
         * values haven't changed and you only want the new entry to inherit the existing
         * dependency rules.
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
        global Boolean   success;
        global String    deploymentId;
        /** PENDING | InProgress | Succeeded | Failed | Canceling | Canceled */
        global String    status;
        global String    message;
        global String    errorDetail;
    }

    // ── Endpoints ────────────────────────────────────────────────────────────

    /**
     * Add a picklist value (and optionally a dependency mapping) to a field,
     * making it available on the specified record type.
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
        try {
            AddPicklistRequest req = (AddPicklistRequest) JSON.deserialize(
                RestContext.request.requestBody.toString(),
                AddPicklistRequest.class
            );
            validateRequest(req);

            String baseUrl    = System.URL.getOrgDomainUrl().toExternalForm();
            String sessionId  = UserInfo.getSessionId();
            String apiVersion = 'v62.0';

            // ── Step 1: read current CustomField metadata (Tooling API) ──────
            Map<String, Object> fieldMeta = readToolingMetadata(
                baseUrl, sessionId, apiVersion,
                'CustomField',
                'TableEnumOrId = \'' + req.objectApiName + '\' AND DeveloperName = \'' +
                req.fieldApiName.removeEnd('__c') + '\''
            );

            // ── Step 2: read current RecordType metadata (Tooling API) ───────
            Map<String, Object> rtMeta = null;
            if (String.isNotBlank(req.recordTypeDevName)) {
                rtMeta = readToolingMetadata(
                    baseUrl, sessionId, apiVersion,
                    'RecordType',
                    'SobjectType = \'' + req.objectApiName + '\' AND DeveloperName = \'' +
                    req.recordTypeDevName + '\''
                );
            }

            // ── Step 3: build updated Metadata objects ────────────────────────
            Metadata.CustomField updatedField = buildUpdatedField(req, fieldMeta);
            Metadata.RecordType  updatedRt    = (rtMeta != null)
                ? buildUpdatedRecordType(req, rtMeta)
                : null;

            // ── Step 4: enqueue deployment (DML — must come after callouts) ───
            Metadata.DeployContainer container = new Metadata.DeployContainer();
            container.addMetadata(updatedField);
            if (updatedRt != null) {
                container.addMetadata(updatedRt);
            }

            Id deployId = Metadata.Operations.enqueueDeployment(
                container,
                new DeployCallback()
            );

            resp.success      = true;
            resp.deploymentId = deployId;
            resp.status       = 'Pending';
            resp.message      = 'Deployment enqueued. Poll GET ?deploymentId=' + deployId;

        } catch (DynamicPicklistException e) {
            resp.success     = false;
            resp.message     = e.getMessage();
        } catch (Exception e) {
            resp.success     = false;
            resp.message     = 'Unexpected error: ' + e.getMessage();
            resp.errorDetail = e.getStackTraceString();
        }
        return resp;
    }

    /**
     * Poll deployment status.
     * GET /services/apexrest/picklist-manager/v1/?deploymentId=<id>
     */
    @HttpGet
    global static ApiResponse checkDeploymentStatus() {
        ApiResponse resp = new ApiResponse();
        String deployId = RestContext.request.params.get('deploymentId');
        if (String.isBlank(deployId)) {
            resp.success = false;
            resp.message = 'Required query param: deploymentId';
            return resp;
        }
        try {
            Metadata.DeployResult result =
                Metadata.Operations.checkDeployStatus(deployId, true);

            resp.success      = true;
            resp.deploymentId = deployId;
            resp.status       = result.status.name();
            resp.message      = result.status.name();

            if (result.details != null && result.details.componentFailures != null) {
                List<String> errors = new List<String>();
                for (Metadata.DeployMessage dm : result.details.componentFailures) {
                    errors.add(dm.fullName + ': ' + dm.problem);
                }
                if (!errors.isEmpty()) {
                    resp.errorDetail = String.join(errors, ' | ');
                }
            }
        } catch (Exception e) {
            resp.success = false;
            resp.message = e.getMessage();
        }
        return resp;
    }

    // ── Tooling API helper ───────────────────────────────────────────────────

    /**
     * Queries the Tooling API and returns the 'Metadata' JSON map from the first record.
     * Throws DynamicPicklistException when no record is found.
     */
    private static Map<String, Object> readToolingMetadata(
        String baseUrl, String sessionId, String apiVersion,
        String toolingType, String whereClause
    ) {
        String soql = 'SELECT+Id,Metadata+FROM+' + toolingType + '+WHERE+' + whereClause.replace(' ', '+');
        String endpoint = baseUrl + '/services/data/' + apiVersion + '/tooling/query/?q=' + soql;

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint(endpoint);
        httpReq.setMethod('GET');
        httpReq.setHeader('Authorization', 'Bearer ' + sessionId);
        httpReq.setHeader('Content-Type', 'application/json');
        httpReq.setTimeout(30000);

        HttpResponse httpResp = new Http().send(httpReq);
        if (httpResp.getStatusCode() != 200) {
            throw new DynamicPicklistException(
                'Tooling API error (' + toolingType + '): HTTP ' +
                httpResp.getStatusCode() + ' – ' + httpResp.getBody()
            );
        }

        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(httpResp.getBody());
        List<Object> records = (List<Object>) body.get('records');
        if (records == null || records.isEmpty()) {
            throw new DynamicPicklistException(
                toolingType + ' not found for query: ' + whereClause
            );
        }
        Map<String, Object> record = (Map<String, Object>) records[0];
        return (Map<String, Object>) record.get('Metadata');
    }

    // ── Metadata builders ────────────────────────────────────────────────────

    private static Metadata.CustomField buildUpdatedField(
        AddPicklistRequest req, Map<String, Object> rawMeta
    ) {
        Metadata.CustomField field = new Metadata.CustomField();
        field.fullName = req.objectApiName + '.' + req.fieldApiName;

        // Carry forward the existing top-level properties from raw metadata
        field.label           = (String) rawMeta.get('label');
        field.description     = (String) rawMeta.get('description');
        field.inlineHelpText  = (String) rawMeta.get('inlineHelpText');

        String typeStr = (String) rawMeta.get('type');
        if (typeStr != null) {
            field.type_x = (Metadata.FieldType) Metadata.FieldType.valueOf(typeStr);
        }

        // ── Rebuild ValueSet from existing metadata ──────────────────────────
        Metadata.ValueSet vs = new Metadata.ValueSet();
        Map<String, Object> rawVs = (Map<String, Object>) rawMeta.get('valueSet');

        if (rawVs != null) {
            vs.restricted = (Boolean) rawVs.get('restricted');

            // Controlling field (may already be set for dependent picklists)
            String existingCtrl = (String) rawVs.get('controllingField');
            vs.controllingField = String.isNotBlank(existingCtrl)
                ? existingCtrl
                : (req.dependency != null ? req.dependency.controllingFieldApiName : null);

            // Carry forward all existing CustomValues
            vs.valueSetDefinition = new Metadata.ValueSetValuesDefinition();
            vs.valueSetDefinition.sorted = false;
            vs.valueSetDefinition.value  = new List<Metadata.CustomValue>();

            Map<String, Object> rawVsd = (Map<String, Object>) rawVs.get('valueSetDefinition');
            if (rawVsd != null) {
                List<Object> rawValues = (List<Object>) rawVsd.get('value');
                if (rawValues != null) {
                    for (Object v : rawValues) {
                        Map<String, Object> rv = (Map<String, Object>) v;
                        Metadata.CustomValue cv = new Metadata.CustomValue();
                        cv.fullName    = (String)  rv.get('fullName');
                        cv.label       = (String)  rv.get('label');
                        cv.default_x   = rv.get('default') == true;
                        cv.isActive    = rv.get('isActive') != false; // default true
                        vs.valueSetDefinition.value.add(cv);
                    }
                }
            }

            // Guard against duplicate
            for (Metadata.CustomValue existing : vs.valueSetDefinition.value) {
                if (existing.fullName == req.picklistValue) {
                    throw new DynamicPicklistException(
                        'Picklist value already exists: ' + req.picklistValue
                    );
                }
            }

            // Append new value
            Metadata.CustomValue newVal = new Metadata.CustomValue();
            newVal.fullName  = req.picklistValue;
            newVal.label     = String.isNotBlank(req.picklistLabel) ? req.picklistLabel : req.picklistValue;
            newVal.default_x = req.isDefault == true;
            newVal.isActive  = true;
            vs.valueSetDefinition.value.add(newVal);

            // ── Rebuild ValueSettings (dependency map) ───────────────────────
            // Carry forward all existing valueSettings entries, then add/merge the new one.
            vs.valueSettings = new List<Metadata.ValueSettings>();

            List<Object> rawSettings = (List<Object>) rawVs.get('valueSettings');
            if (rawSettings != null) {
                for (Object s : rawSettings) {
                    Map<String, Object> rs = (Map<String, Object>) s;
                    Metadata.ValueSettings setting = new Metadata.ValueSettings();
                    setting.valueName = (String) rs.get('valueName');
                    List<Object> cfvs = (List<Object>) rs.get('controllingFieldValue');
                    setting.controllingFieldValue = new List<String>();
                    if (cfvs != null) {
                        for (Object cfv : cfvs) {
                            setting.controllingFieldValue.add((String) cfv);
                        }
                    }
                    vs.valueSettings.add(setting);
                }
            }

            // Add ValueSettings for the new picklist value if dependency provided
            if (req.dependency != null &&
                req.dependency.controllingValues != null &&
                !req.dependency.controllingValues.isEmpty()
            ) {
                Metadata.ValueSettings newSetting = new Metadata.ValueSettings();
                newSetting.valueName             = req.picklistValue;
                newSetting.controllingFieldValue = req.dependency.controllingValues;
                vs.valueSettings.add(newSetting);
            }
        }

        field.valueSet = vs;
        return field;
    }

    private static Metadata.RecordType buildUpdatedRecordType(
        AddPicklistRequest req, Map<String, Object> rawMeta
    ) {
        Metadata.RecordType rt = new Metadata.RecordType();
        rt.fullName   = req.objectApiName + '.' + req.recordTypeDevName;
        rt.label      = (String) rawMeta.get('label');
        rt.active     = rawMeta.get('active') != false;
        rt.description= (String) rawMeta.get('description');

        rt.picklistValues = new List<Metadata.RecordTypePicklistValue>();

        List<Object> rawPlvs = (List<Object>) rawMeta.get('picklistValues');
        if (rawPlvs != null) {
            for (Object p : rawPlvs) {
                Map<String, Object> rp = (Map<String, Object>) p;
                Metadata.RecordTypePicklistValue rtplv = new Metadata.RecordTypePicklistValue();
                rtplv.picklist = (String) rp.get('picklist');

                List<Metadata.PicklistValueMapping> mappings = new List<Metadata.PicklistValueMapping>();
                List<Object> rawVals = (List<Object>) rp.get('values');
                if (rawVals != null) {
                    for (Object val : rawVals) {
                        Map<String, Object> rv = (Map<String, Object>) val;
                        Metadata.PicklistValueMapping pvm = new Metadata.PicklistValueMapping();
                        pvm.masterLabel = (String) rv.get('fullName');
                        pvm.default_x   = rv.get('default') == true;
                        mappings.add(pvm);
                    }
                }

                // Inject the new value into the target picklist on this record type
                if (rtplv.picklist == req.fieldApiName) {
                    Metadata.PicklistValueMapping newPvm = new Metadata.PicklistValueMapping();
                    newPvm.masterLabel = req.picklistValue;
                    newPvm.default_x   = req.isDefault == true;
                    mappings.add(newPvm);
                }

                rtplv.values      = mappings;
                rt.picklistValues.add(rtplv);
            }
        }

        return rt;
    }

    // ── Validation ───────────────────────────────────────────────────────────

    private static void validateRequest(AddPicklistRequest req) {
        List<String> errors = new List<String>();
        if (String.isBlank(req.objectApiName))  errors.add('objectApiName is required');
        if (String.isBlank(req.fieldApiName))   errors.add('fieldApiName is required');
        if (String.isBlank(req.picklistValue))  errors.add('picklistValue is required');
        if (req.dependency != null) {
            if (String.isBlank(req.dependency.controllingFieldApiName))
                errors.add('dependency.controllingFieldApiName is required when dependency is provided');
            if (req.dependency.controllingValues == null || req.dependency.controllingValues.isEmpty())
                errors.add('dependency.controllingValues must not be empty when dependency is provided');
        }
        if (!errors.isEmpty()) {
            throw new DynamicPicklistException(String.join(errors, '; '));
        }
    }

    // ── Supporting types ─────────────────────────────────────────────────────

    global class DynamicPicklistException extends Exception {}

    global class DeployCallback implements Metadata.DeployCallback {
        global void handleResult(Metadata.DeployResult result, Metadata.DeployCallbackContext ctx) {
            // Intentionally lightweight — Jenkins polls the GET endpoint instead.
            // Add platform event publish or custom object logging here if needed.
        }
    }
}
