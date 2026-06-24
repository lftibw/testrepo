/**
 * Unit tests for DynamicPicklistManagerAPI.
 *
 * Because Metadata.Operations.enqueueDeployment() and HTTP callouts cannot
 * run together in a test, the tests verify:
 *   (a) input validation errors surface cleanly
 *   (b) the GET status endpoint handles missing/bad params gracefully
 *   (c) a mock HTTP callout returns expected JSON structure
 */
@IsTest
private class DynamicPicklistManagerAPITest {

    // ── Mock for Tooling API callout ─────────────────────────────────────────

    private class ToolingApiMock implements HttpCalloutMock {
        private String objectName;
        private String fieldName;
        private String recordTypeDevName;

        ToolingApiMock(String objectName, String fieldName, String recordTypeDevName) {
            this.objectName        = objectName;
            this.fieldName         = fieldName;
            this.recordTypeDevName = recordTypeDevName;
        }

        public HttpResponse respond(HttpRequest req) {
            HttpResponse resp = new HttpResponse();
            resp.setStatusCode(200);
            resp.setHeader('Content-Type', 'application/json');

            if (req.getEndpoint().contains('CustomField')) {
                resp.setBody(buildCustomFieldBody());
            } else if (req.getEndpoint().contains('RecordType')) {
                resp.setBody(buildRecordTypeBody());
            } else {
                resp.setStatusCode(400);
                resp.setBody('{"message":"Unknown tooling type"}');
            }
            return resp;
        }

        private String buildCustomFieldBody() {
            return JSON.serialize(new Map<String, Object>{
                'totalSize' => 1,
                'records'   => new List<Object>{
                    new Map<String, Object>{
                        'Id'       => '00N000000000001',
                        'Metadata' => new Map<String, Object>{
                            'label'       => 'MS Marketing Category',
                            'type'        => 'Picklist',
                            'description' => null,
                            'valueSet'    => new Map<String, Object>{
                                'restricted'      => true,
                                'controllingField' => 'STO__c',
                                'valueSetDefinition' => new Map<String, Object>{
                                    'sorted' => false,
                                    'value'  => new List<Object>{
                                        new Map<String, Object>{
                                            'fullName' => 'Print',
                                            'label'    => 'Print',
                                            'default'  => false,
                                            'isActive' => true
                                        },
                                        new Map<String, Object>{
                                            'fullName' => 'TV',
                                            'label'    => 'TV',
                                            'default'  => false,
                                            'isActive' => true
                                        }
                                    }
                                },
                                'valueSettings' => new List<Object>{
                                    new Map<String, Object>{
                                        'valueName'             => 'Print',
                                        'controllingFieldValue' => new List<String>{'Traditional'}
                                    },
                                    new Map<String, Object>{
                                        'valueName'             => 'TV',
                                        'controllingFieldValue' => new List<String>{'Broadcast'}
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }

        private String buildRecordTypeBody() {
            return JSON.serialize(new Map<String, Object>{
                'totalSize' => 1,
                'records'   => new List<Object>{
                    new Map<String, Object>{
                        'Id'       => '012000000000001',
                        'Metadata' => new Map<String, Object>{
                            'label'          => 'Media Sales',
                            'active'         => true,
                            'description'    => null,
                            'picklistValues' => new List<Object>{
                                new Map<String, Object>{
                                    'picklist' => fieldName,
                                    'values'   => new List<Object>{
                                        new Map<String, Object>{
                                            'fullName' => 'Print',
                                            'default'  => false
                                        },
                                        new Map<String, Object>{
                                            'fullName' => 'TV',
                                            'default'  => false
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    // ── Helper to set up REST context ────────────────────────────────────────

    private static void setupPost(String bodyJson) {
        RestRequest req   = new RestRequest();
        RestResponse resp = new RestResponse();
        req.requestURI    = '/services/apexrest/picklist-manager/v1/';
        req.httpMethod    = 'POST';
        req.requestBody   = Blob.valueOf(bodyJson);
        RestContext.request  = req;
        RestContext.response = resp;
    }

    private static void setupGet(String deploymentId) {
        RestRequest req   = new RestRequest();
        RestResponse resp = new RestResponse();
        req.requestURI    = '/services/apexrest/picklist-manager/v1/';
        req.httpMethod    = 'GET';
        req.params        = new Map<String, String>{ 'deploymentId' => deploymentId };
        RestContext.request  = req;
        RestContext.response = resp;
    }

    // ── Validation tests (no callout needed) ─────────────────────────────────

    @IsTest
    static void post_missingObjectApiName_returnsFalse() {
        setupPost('{"fieldApiName":"MSMarketingCategory__c","picklistValue":"Digital_Media"}');
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        System.assertEquals(false, resp.success,  'Should fail validation');
        System.assert(resp.message.contains('objectApiName'), 'Error should mention objectApiName');
    }

    @IsTest
    static void post_missingFieldApiName_returnsFalse() {
        setupPost('{"objectApiName":"Account","picklistValue":"Digital_Media"}');
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        System.assertEquals(false, resp.success);
        System.assert(resp.message.contains('fieldApiName'));
    }

    @IsTest
    static void post_missingPicklistValue_returnsFalse() {
        setupPost('{"objectApiName":"Account","fieldApiName":"MSMarketingCategory__c"}');
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        System.assertEquals(false, resp.success);
        System.assert(resp.message.contains('picklistValue'));
    }

    @IsTest
    static void post_dependencyMissingControllingValues_returnsFalse() {
        String body = JSON.serialize(new Map<String, Object>{
            'objectApiName'    => 'Account',
            'fieldApiName'     => 'MSMarketingCategory__c',
            'picklistValue'    => 'Digital_Media',
            'dependency'       => new Map<String, Object>{
                'controllingFieldApiName' => 'STO__c',
                'controllingValues'       => new List<String>()
            }
        });
        setupPost(body);
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        System.assertEquals(false, resp.success);
        System.assert(resp.message.contains('controllingValues'));
    }

    // ── GET status: missing param ─────────────────────────────────────────────

    @IsTest
    static void get_missingDeploymentId_returnsFalse() {
        RestRequest req   = new RestRequest();
        RestResponse resp = new RestResponse();
        req.requestURI    = '/services/apexrest/picklist-manager/v1/';
        req.httpMethod    = 'GET';
        req.params        = new Map<String, String>();
        RestContext.request  = req;
        RestContext.response = resp;

        DynamicPicklistManagerAPI.ApiResponse apiResp = DynamicPicklistManagerAPI.checkDeploymentStatus();
        System.assertEquals(false, apiResp.success);
        System.assert(apiResp.message.contains('deploymentId'));
    }

    // ── Full happy-path with mock callout ────────────────────────────────────

    @IsTest
    static void post_validRequest_withDependency_enqueuedSuccessfully() {
        // The mock responds to both CustomField and RecordType Tooling API queries.
        // The actual Metadata.Operations.enqueueDeployment() is a no-op in tests
        // (Salesforce stubs it and returns a fake async Id).
        Test.setMock(HttpCalloutMock.class,
            new ToolingApiMock('Account', 'MSMarketingCategory__c', 'Media_Sales'));

        String body = JSON.serialize(new Map<String, Object>{
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
        setupPost(body);

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(true,    resp.success, resp.message);
        System.assertNotEquals(null, resp.deploymentId, 'Should return a deployment Id');
        System.assertEquals('Pending', resp.status);
    }

    @IsTest
    static void post_validRequest_withoutRecordType_enqueuedSuccessfully() {
        Test.setMock(HttpCalloutMock.class,
            new ToolingApiMock('Account', 'MSMarketingCategory__c', null));

        String body = JSON.serialize(new Map<String, Object>{
            'objectApiName'  => 'Account',
            'fieldApiName'   => 'MSMarketingCategory__c',
            'picklistValue'  => 'Podcast',
            'picklistLabel'  => 'Podcast',
            'isDefault'      => false
        });
        setupPost(body);

        Test.startTest();
        DynamicPicklistManagerAPI.ApiResponse resp = DynamicPicklistManagerAPI.addPicklistValue();
        Test.stopTest();

        System.assertEquals(true, resp.success, resp.message);
    }
}
