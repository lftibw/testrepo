/**
 * Unit tests for DynamicPicklistManagerAPI.
 *
 * The class talks to the Tooling API via HTTP callouts, so all paths are exercised
 * through HttpCalloutMock. The mock answers the two GET queries (CustomField,
 * RecordType) and the PATCH writes (204 No Content).
 */
@IsTest
private class DynamicPicklistManagerAPITest {

    // ── Mock ─────────────────────────────────────────────────────────────────

    private class ToolingMock implements HttpCalloutMock {
        Integer patchStatus;        // status to return on PATCH (204 = success)
        Boolean fieldHasDependency; // include controllingField/valueSettings in CustomField

        ToolingMock(Integer patchStatus, Boolean fieldHasDependency) {
            this.patchStatus        = patchStatus;
            this.fieldHasDependency = fieldHasDependency;
        }

        public HttpResponse respond(HttpRequest req) {
            HttpResponse resp = new HttpResponse();
            resp.setHeader('Content-Type', 'application/json');

            if (req.getMethod() == 'GET' && req.getEndpoint().contains('CustomField')) {
                resp.setStatusCode(200);
                resp.setBody(customFieldQueryBody());
            } else if (req.getMethod() == 'GET' && req.getEndpoint().contains('RecordType')) {
                resp.setStatusCode(200);
                resp.setBody(recordTypeQueryBody());
            } else if (req.getMethod() == 'PATCH') {
                resp.setStatusCode(patchStatus);
                resp.setBody(patchStatus == 204 ? '' : '[{"message":"deploy error","errorCode":"X"}]');
            } else {
                resp.setStatusCode(400);
                resp.setBody('{"error":"unexpected request"}');
            }
            return resp;
        }

        private String customFieldQueryBody() {
            Map<String, Object> valueSet = new Map<String, Object>{
                'restricted' => true,
                'valueSetDefinition' => new Map<String, Object>{
                    'sorted' => false,
                    'value'  => new List<Object>{
                        new Map<String, Object>{ 'fullName' => 'Print', 'label' => 'Print', 'default' => false, 'isActive' => true },
                        new Map<String, Object>{ 'fullName' => 'TV',    'label' => 'TV',    'default' => false, 'isActive' => true }
                    }
                }
            };
            if (fieldHasDependency) {
                valueSet.put('controllingField', 'STO__c');
                valueSet.put('valueSettings', new List<Object>{
                    new Map<String, Object>{ 'valueName' => 'Print', 'controllingFieldValue' => new List<String>{ 'Traditional' } },
                    new Map<String, Object>{ 'valueName' => 'TV',    'controllingFieldValue' => new List<String>{ 'Broadcast' } }
                });
            }
            return JSON.serialize(new Map<String, Object>{
                'totalSize' => 1,
                'records'   => new List<Object>{
                    new Map<String, Object>{
                        'Id'       => '00N0000000000001',
                        'Metadata' => new Map<String, Object>{
                            'label'    => 'MS Marketing Category',
                            'type'     => 'Picklist',
                            'valueSet' => valueSet
                        }
                    }
                }
            });
        }

        private String recordTypeQueryBody() {
            return JSON.serialize(new Map<String, Object>{
                'totalSize' => 1,
                'records'   => new List<Object>{
                    new Map<String, Object>{
                        'Id'       => '0120000000000001',
                        'Metadata' => new Map<String, Object>{
                            'label'  => 'Media Sales',
                            'active' => true,
                            'picklistValues' => new List<Object>{
                                new Map<String, Object>{
                                    'picklist' => 'MSMarketingCategory__c',
                                    'values'   => new List<Object>{
                                        new Map<String, Object>{ 'fullName' => 'Print', 'default' => false },
                                        new Map<String, Object>{ 'fullName' => 'TV',    'default' => false }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static void setupPost(String bodyJson) {
        RestRequest req = new RestRequest();
        req.requestURI  = '/services/apexrest/picklist-manager/v1/';
        req.httpMethod  = 'POST';
        req.requestBody = Blob.valueOf(bodyJson);
        RestContext.request  = req;
        RestContext.response = new RestResponse();
    }

    private static String fullRequest() {
        return JSON.serialize(new Map<String, Object>{
            'objectApiName'     => 'Account',
            'fieldApiName'      => 'MSMarketingCategory__c',
            'recordTypeDevName' => 'Media_Sales',
            'picklistValue'     => 'Digital_Media',
            'picklistLabel'     => 'Digital Media',
            'isDefault'         => false,
            'dependency'        => new Map<String, Object>{
                'controllingFieldApiName' => 'STO__c',
                'controllingValues'       => new List<String>{ 'Online', 'Digital' }
            }
        });
    }

    // ── Happy paths ──────────────────────────────────────────────────────────

    @IsTest
    static void fullRequest_withDependencyAndRecordType_succeeds() {
        Test.setMock(HttpCalloutMock.class, new ToolingMock(204, true));
        setupPost(fullRequest());

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(true, resp.success, resp.message);
        System.assertEquals('Succeeded', resp.status);
    }

    @IsTest
    static void request_withoutDependency_setsControllingFieldFresh() {
        // Field starts with no dependency; request adds one → controllingField gets set.
        Test.setMock(HttpCalloutMock.class, new ToolingMock(204, false));
        setupPost(fullRequest());

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(true, resp.success, resp.message);
    }

    @IsTest
    static void request_withoutRecordType_skipsRecordTypePatch() {
        Test.setMock(HttpCalloutMock.class, new ToolingMock(204, true));
        setupPost(JSON.serialize(new Map<String, Object>{
            'objectApiName' => 'Account',
            'fieldApiName'  => 'MSMarketingCategory__c',
            'picklistValue' => 'Podcast',
            'picklistLabel' => 'Podcast'
        }));

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(true, resp.success, resp.message);
    }

    // ── Failure paths ────────────────────────────────────────────────────────

    @IsTest
    static void patchFailure_surfacesError() {
        Test.setMock(HttpCalloutMock.class, new ToolingMock(400, true));
        setupPost(fullRequest());

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(false, resp.success);
        System.assertEquals('Failed', resp.status);
        System.assert(!resp.errorDetail.isEmpty(), 'Should capture error detail');
    }

    @IsTest
    static void duplicateValue_isRejected() {
        Test.setMock(HttpCalloutMock.class, new ToolingMock(204, true));
        // 'TV' already exists in the mock value set.
        setupPost(JSON.serialize(new Map<String, Object>{
            'objectApiName' => 'Account',
            'fieldApiName'  => 'MSMarketingCategory__c',
            'picklistValue' => 'TV'
        }));

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(false, resp.success);
        System.assert(resp.message.contains('already exists'), resp.message);
    }

    // ── Validation (no callout) ──────────────────────────────────────────────

    @IsTest
    static void missingRequiredFields_failValidation() {
        setupPost('{"objectApiName":"Account"}');
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        System.assertEquals(false, resp.success);
        System.assert(resp.message.contains('fieldApiName'), resp.message);
        System.assert(resp.message.contains('picklistValue'), resp.message);
    }

    @IsTest
    static void dependencyWithoutControllingValues_failsValidation() {
        setupPost(JSON.serialize(new Map<String, Object>{
            'objectApiName' => 'Account',
            'fieldApiName'  => 'MSMarketingCategory__c',
            'picklistValue' => 'Digital_Media',
            'dependency'    => new Map<String, Object>{
                'controllingFieldApiName' => 'STO__c',
                'controllingValues'       => new List<String>()
            }
        }));
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        System.assertEquals(false, resp.success);
        System.assert(resp.message.contains('controllingValues'), resp.message);
    }
}
