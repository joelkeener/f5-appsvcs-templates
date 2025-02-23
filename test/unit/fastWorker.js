/* Copyright 2021 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */
/* eslint-disable no-console */

'use strict';

const path = require('path');
const url = require('url');

const fs = require('fs');
const mockfs = require('mock-fs');
const assert = require('assert').strict;
const nock = require('nock');
const sinon = require('sinon');
const chai = require('chai');

const expect = chai.expect;
const chaiResponseValidator = require('chai-openapi-response-validator').default;

chai.use(chaiResponseValidator(path.join(__dirname, '../../docs/openapi.yml')));

const fast = require('@f5devcentral/f5-fast-core');
const atgStorage = require('@f5devcentral/atg-storage');

const AS3DriverConstantsKey = require('../../lib/drivers').AS3DriverConstantsKey;
const { SecretsBase64 } = require('../../lib/secrets');

const FASTWorker = require('../../nodejs/fastWorker');
const IpamProviders = require('../../lib/ipam');

const templatesPath = path.join(process.cwd(), 'templates');
const testCtx = {
    tracer: {
        startChildSpan: sinon.stub().returns({
            log: sinon.stub(),
            finish: sinon.stub(),
            error: sinon.stub()
        })
    },
    span: {
        log: sinon.stub(),
        error: sinon.stub(),
        finish: sinon.stub()
    }
};

class RestOp {
    constructor(uri) {
        this.uri = {
            pathname: uri,
            path: uri,
            href: uri
        };
        this.body = '';
        this.status = 200;
        this.headers = { 'content-type': 'application/json' };
        this.method = '';
    }

    setHeaders() {}

    getHeader(name) {
        return this.headers[name];
    }

    getContentType() {
        return this.headers['content-type'];
    }

    setStatusCode(status) {
        this.status = status;
    }

    getStatusCode() {
        return this.status;
    }

    setBody(body) {
        this.body = body;
    }

    getBody() {
        return this.body;
    }

    setUri(uri) {
        this.uri = uri;
    }

    getUri() {
        const uri = url.parse(`${this.uri.path}`);
        if (uri.query) {
            uri.query = uri.query
                .split('&')
                .reduce((acc, curr) => {
                    const [key, value] = curr.split('=');
                    acc[key] = value;
                    return acc;
                }, {});
        } else {
            uri.query = {};
        }
        return uri;
    }

    getMethod() {
        return this.method;
    }

    setMethod() {
    }

    complete() {
        if (this.completed) {
            throw new Error('REST operation has already been completed');
        }
        this.completed = true;
    }
}

// Update worker instance to mimic iControl LX environment
const patchWorker = (worker) => {
    worker.logger = {
        severe: (str) => {
            console.log(str);
            assert(false, 'worker hit a severe error');
        },
        error: console.log,
        info: console.log,
        fine: console.log,
        log: console.log
    };
    worker.ipamProviders = new IpamProviders({
        secretsManager: worker.secretsManager,
        logger: worker.logger,
        transactionLogger: worker.transactionLogger
    });
    worker.setDeviceInfo({}, testCtx);
    worker.completedRestOp = false;
    worker.completeRestOperation = function (op) {
        console.log('Completed REST Operation:');
        console.log(JSON.stringify(op, null, 2));
        this.completedRestOp = true;
        op.complete();
    };
    const ensureCompletedOp = (fn) => {
        worker[`_${fn}`] = worker[fn];
        worker[fn] = function (op) {
            this.completedRestOp = false;
            return Promise.resolve()
                .then(() => {
                    op.method = fn.substring(2);
                })
                .then(() => this[`_${fn}`](op))
                .then(() => {
                    if (!this.completedRestOp) {
                        throw new Error(`failed to call completeRestOperation() in ${fn}()`);
                    }
                });
        };
    };
    ensureCompletedOp('onGet');
    ensureCompletedOp('onPost');
    ensureCompletedOp('onDelete');
    ensureCompletedOp('onPatch');

    mockfs({
        [worker.uploadPath]: mockfs.load(worker.uploadPath, { recursive: true }),
        [worker.scratchPath]: {
            'testset-github.zip': mockfs.load(path.join(worker.uploadPath, 'testset.zip'))
        },
        [worker.templatesPath]: mockfs.load(path.join(process.cwd(), 'templates'), { recursive: true }),
        [(path.join(process.cwd(), 'lib'))]: mockfs.load(path.join(process.cwd(), 'lib'), { lazy: false, recursive: true })
    });
};

let testStorage = null;

class TeemDeviceMock {
    report(reportName, reportVersion, declaration, extraFields) {
        // console.error(`${reportName}: ${JSON.stringify(extraFields)}`);
        return Promise.resolve()
            .then(() => {
                assert(reportName);
                assert(declaration);
                assert(extraFields);
            });
    }
}

function copyStorage(src) {
    return new atgStorage.StorageMemory(Object.assign({}, src.data));
}

function createWorker() {
    const worker = new FASTWorker({
        templateStorage: copyStorage(testStorage),
        configStorage: new atgStorage.StorageMemory(),
        secretsManager: new SecretsBase64(),
        fsTemplateList: [
            'examples',
            'bigip-fast-templates'
        ],
        configPath: process.cwd(),
        templatesPath,
        uploadPath: './test/unit/mockDir'
    });
    patchWorker(worker);

    worker.teemDevice = new TeemDeviceMock();

    worker.hookCompleteRestOp();
    return worker;
}

function resetScope(scope) {
    scope.persist(false);
    scope.interceptors.forEach(nock.removeInterceptor);
    return scope;
}

describe('fastWorker tests', function () {
    this.timeout(3000);
    const host = 'http://localhost:8100';
    const as3ep = '/mgmt/shared/appsvcs/declare';
    const as3TaskEp = '/mgmt/shared/appsvcs/task';
    const as3stub = {
        class: 'ADC',
        schemaVersion: '3.0.0'
    };
    const as3App = {
        class: 'Application',
        constants: {
            [AS3DriverConstantsKey]: {
                template: 'foo/bar'
            }
        }
    };
    let as3Scope;

    before(function () {
        const tsNames = [
            'bigip-fast-templates',
            'examples'
        ];
        testStorage = new atgStorage.StorageMemory();
        return fast.DataStoreTemplateProvider.fromFs(testStorage, templatesPath, tsNames);
    });

    beforeEach(function () {
        this.clock = sinon.useFakeTimers();
        nock(host)
            .persist()
            .get('/mgmt/tm/sys/provision')
            .reply(200, {
                kind: 'tm:sys:provision:provisioncollectionstate',
                selfLink: 'https://localhost/mgmt/tm/sys/provision?ver=15.0.1.1',
                items: [
                    {
                        kind: 'tm:sys:provision:provisionstate',
                        name: 'afm',
                        fullPath: 'afm',
                        generation: 1,
                        selfLink: 'https://localhost/mgmt/tm/sys/provision/afm?ver=15.0.1.1',
                        cpuRatio: 0,
                        diskRatio: 0,
                        level: 'none',
                        memoryRatio: 0
                    },
                    {
                        kind: 'tm:sys:provision:provisionstate',
                        name: 'asm',
                        fullPath: 'asm',
                        generation: 1,
                        selfLink: 'https://localhost/mgmt/tm/sys/provision/asm?ver=15.0.1.1',
                        cpuRatio: 0,
                        diskRatio: 0,
                        level: 'nominal',
                        memoryRatio: 0
                    }
                ]
            });

        nock(host)
            .persist()
            .get('/mgmt/shared/telemetry/info')
            .reply(200, {
            });

        nock(host)
            .persist()
            .get('/mgmt/shared/identified-devices/config/device-info')
            .reply(200, {
                platform: 'Z100',
                machineId: 'some-guid',
                hostname: 'fast.unit.test.host',
                version: '13.1.1.4',
                product: 'BIG-IP',
                platformMarketingName: 'BIG-IP Virtual Edition',
                edition: 'Engineering Hotfix',
                build: '0.140.4',
                restFrameworkVersion: '13.1.1.4-0.0.4',
                mcpDeviceName: '/Common/bigip.a',
                kind: 'shared:resolver:device-groups:deviceinfostate',
                selfLink: 'https://localhost/mgmt/shared/identified-devices/config/device-info'
            });

        nock(host)
            .persist()
            .get('/mgmt/tm/cm/sync-status')
            .reply(200, {
                entries: {
                    'https://localhost/mgmt/tm/cm/sync-status/0': {
                        nestedStats: {
                            entries: {
                                status: {
                                    description: 'Standalone'
                                }
                            }
                        }
                    }
                }
            });

        nock(host)
            .persist()
            .get('/mgmt/shared/appsvcs/info')
            .reply(200, {
                version: '3.16'
            });

        as3Scope = nock(host)
            .persist()
            .get(as3ep)
            .query(true)
            .reply(200, Object.assign({}, as3stub, {
                tenant: {
                    class: 'Tenant',
                    app: as3App,
                    foo: as3App,
                    bar: as3App,
                    foobar: as3App
                }
            }));
    });

    afterEach(function () {
        nock.cleanAll();
        this.clock.restore();
        mockfs.restore();
    });

    describe('worker methods', function () {
        it('on_start', function () {
            const worker = createWorker();

            // Clear the data store
            worker.storage.data = {};

            nock(host)
                .persist()
                .post(`${as3ep}/Common?async=true`)
                .reply(202, {});

            const scope = nock(host)
                .get('/mgmt/shared/iapp/blocks')
                .reply(200, { items: [] })
                .post('/mgmt/shared/iapp/blocks')
                .reply(200, {});

            return worker.onStart(
                () => {}, // success callback
                () => assert(false) // error callback
            )
                .then(() => assert(scope.isDone(), 'iApps block storage endpoint was not accessed'))
                .then(() => worker.templateProvider.list())
                .then((tmplList) => {
                    assert(tmplList.includes('examples/simple_http'));
                })
                .then(() => {
                    assert.deepStrictEqual(worker.deviceInfo, {
                        build: '0.140.4',
                        edition: 'Engineering Hotfix',
                        fullVersion: '13.1.1.4-0.140.4',
                        hostname: 'fast.unit.test.host',
                        platform: 'Z100',
                        platformName: 'BIG-IP Virtual Edition',
                        product: 'BIG-IP',
                        version: '13.1.1.4'
                    }, 'device info should be set');
                });
        });
        it('onConfigSync', function () {
            const worker = createWorker();
            worker.storage.clearCache = sinon.fake();
            worker.configStorage.clearCache = sinon.fake();
            worker.templateProvider.invalidateCache = sinon.fake();
            worker.driver.invalidateCache = sinon.fake();

            return worker.onConfigSync()
                .then(() => {
                    assert(worker.storage.clearCache.calledOnce);
                    assert(worker.configStorage.clearCache.calledOnce);
                    assert(worker.templateProvider.invalidateCache.calledOnce);
                    assert(worker.templateProvider.invalidateCache.calledOnce);
                });
        });
        it('onStartCompleted', function () {
            const worker = createWorker();
            nock(host)
                .get('/mgmt/shared/appsvcs/info')
                .reply(200, {});
            return Promise.resolve()
                .then(() => worker.onStartCompleted(
                    () => {}, // success callback
                    () => assert(false), // error callback
                    undefined,
                    ''
                ));
        });
        it('hydrateSchema - enumFromBigip is a string', function () {
            const worker = createWorker();
            worker.configStorage.data.config = {
                ipamProviders: [
                    { name: 'bar' }
                ]
            };

            const inputSchema = {
                properties: {
                    foo: {
                        type: 'string',
                        enumFromBigip: 'ltm/profile/http-compression'
                    },
                    fooItems: {
                        type: 'array',
                        items: {
                            type: 'string',
                            enumFromBigip: 'ltm/profile/http-compression'
                        }
                    },
                    multipleEndpoints: {
                        type: 'string',
                        enumFromBigip: [
                            'ltm/profile/http-compression',
                            'ltm/profile/http-compression2'
                        ]
                    },
                    fooIpam: {
                        type: 'string',
                        ipFromIpam: true
                    },
                    fooIpamItems: {
                        type: 'array',
                        items: {
                            type: 'string',
                            ipFromIpam: true
                        }
                    }
                }
            };
            nock(host)
                .persist()
                .get('/mgmt/tm/ltm/profile/http-compression?$select=fullPath')
                .reply(200, {
                    kind: 'tm:ltm:profile:http-compression:http-compressioncollectionstate',
                    selfLink: 'https://localhost/mgmt/tm/ltm/profile/http-compression?$select=fullPath&ver=15.0.1.1',
                    items: [
                        { fullPath: '/Common/httpcompression' },
                        { fullPath: '/Common/wan-optimized-compression' }
                    ]
                })
                .get('/mgmt/tm/ltm/profile/http-compression2?$select=fullPath')
                .reply(200, {
                    kind: 'tm:ltm:profile:http-compression:http-compressioncollectionstate',
                    selfLink: 'https://localhost/mgmt/tm/ltm/profile/http-compression2?$select=fullPath&ver=15.0.1.1',
                    items: [
                        { fullPath: '/Common/httpcompression2' },
                        { fullPath: '/Common/wan-optimized-compression2' }
                    ]
                });

            const tmpl = {
                _parametersSchema: inputSchema
            };
            return worker.hydrateSchema(tmpl, 0, false, testCtx)
                .then((schema) => {
                    console.log(schema);
                    assert.deepEqual(schema.properties.foo.enum, [
                        '/Common/httpcompression',
                        '/Common/wan-optimized-compression'
                    ]);
                    assert.deepEqual(schema.properties.fooItems.items.enum, [
                        '/Common/httpcompression',
                        '/Common/wan-optimized-compression'
                    ]);
                    assert.deepEqual(schema.properties.multipleEndpoints.enum, [
                        '/Common/httpcompression',
                        '/Common/wan-optimized-compression',
                        '/Common/httpcompression2',
                        '/Common/wan-optimized-compression2'
                    ]);
                    assert.deepEqual(schema.properties.fooIpam.enum, [
                        'bar'
                    ]);
                    assert.deepEqual(schema.properties.fooIpamItems.items.enum, [
                        'bar'
                    ]);
                });
        });
        it('hydrateSchema - enumFromBigip is an object', function () {
            this.timeout(5000);
            const worker = createWorker();
            worker.configStorage.data.config = {
                ipamProviders: [
                    { name: 'bar' }
                ]
            };
            worker.bigip.getSharedObjects = sinon.stub().resolves(['test_cert01.pem', 'test_cert02.pem']);
            const inputSchema = {
                properties: {
                    fileWithPathOnly: {
                        type: 'string',
                        enumFromBigip: {
                            path: 'files'
                        }
                    },
                    fileWithPathAndFilter: {
                        type: 'string',
                        enumFromBigip: {
                            path: 'files',
                            filter: {
                                type: '^CERT.*'
                            }
                        }
                    },
                    fileWithMultiplePaths: {
                        type: 'string',
                        enumFromBigip: {
                            path: [
                                'files',
                                'waf-policy'
                            ],
                            filter: {
                                type: '^CERT.*'
                            }
                        }
                    },
                    endpointWithoutPath: {
                        type: 'string',
                        enumFromBigip: {
                            filter: {
                                type: '^CERT.*'
                            }
                        }
                    }
                }
            };

            const tmpl = {
                _parametersSchema: inputSchema
            };
            return worker.hydrateSchema(tmpl, 0, false, testCtx)
                .then((schema) => {
                    console.log(schema);
                    console.log(worker.bigip.getSharedObjects);
                    assert.deepEqual(worker.bigip.getSharedObjects.firstCall.args, ['files', undefined, testCtx]);
                    assert.deepEqual(worker.bigip.getSharedObjects.secondCall.args, ['files', { type: '^CERT.*' }, testCtx]);
                    assert.deepEqual(worker.bigip.getSharedObjects.thirdCall.args, ['files', { type: '^CERT.*' }, testCtx]);
                    assert.deepEqual(worker.bigip.getSharedObjects.lastCall.args, ['waf-policy', { type: '^CERT.*' }, testCtx]);
                });
        });
        it('bigipDependencies', function () {
            const worker = createWorker();

            const checkTmplDeps = (yamltext) => {
                let retTmpl;
                return Promise.resolve()
                    .then(() => fast.Template.loadYaml(yamltext))
                    .then((tmpl) => {
                        retTmpl = tmpl;
                        return tmpl;
                    })
                    .then(tmpl => worker.checkDependencies(tmpl, 0, false, testCtx))
                    .then(() => retTmpl);
            };

            return Promise.resolve()
                .then(() => checkTmplDeps(`
                    title: root simple pass
                    bigipDependencies:
                        - asm
                    template: |
                        Some text
                `))
                .catch(e => assert(false, e.message))
                .then(() => checkTmplDeps(`
                    title: root simple fail
                    bigipDependencies:
                        - cgnat
                    template: |
                        Some text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /missing modules: cgnat/))
                .then(() => checkTmplDeps(`
                    title: root anyOf
                    anyOf:
                        - {}
                        - title: asm
                          bigipDependencies: [asm]
                          template: foo
                        - title: cgnat
                          bigipDependencies: [cgnat]
                          template: bar
                    template: |
                        Some text
                `))
                .then((tmpl) => {
                    assert.strictEqual(tmpl._anyOf.length, 2);
                    assert.strictEqual(tmpl._anyOf[1].title, 'asm');
                })
                .then(() => checkTmplDeps(`
                    title: root allOf
                    allOf:
                        - title: cgnat
                          bigipDependencies: [cgnat]
                          template: bar
                    template: |
                        Some text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /missing modules: cgnat/))
                .then(() => checkTmplDeps(`
                    title: root oneOf fail
                    oneOf:
                        - title: cgnat
                          bigipDependencies: [cgnat]
                          template: bar
                    template: |
                        Some text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /no single oneOf had valid/))
                .then(() => checkTmplDeps(`
                    title: root oneOf pass
                    oneOf:
                        - title: cgnat
                          bigipDependencies: [cgnat]
                          template: bar
                        - title: asm
                          bigipDependencies: [asm]
                          template: foo
                    template: |
                        Some text
                `))
                .then((tmpl) => {
                    assert.strictEqual(tmpl._oneOf.length, 1);
                    assert.strictEqual(tmpl._oneOf[0].title, 'asm');
                });
        });
        it('as3_version_check', function () {
            const worker = createWorker();

            const checkVersion = (yamltext) => {
                let retTmpl;
                return Promise.resolve()
                    .then(() => fast.Template.loadYaml(yamltext))
                    .then((tmpl) => {
                        retTmpl = tmpl;
                        return tmpl;
                    })
                    .then(tmpl => worker.checkDependencies(tmpl, 0, false, testCtx))
                    .then(() => retTmpl);
            };

            return Promise.resolve()
                .then(() => checkVersion(`
                    title: no version
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkVersion(`
                    title: version met
                    bigipMinimumAS3: 3.16.0
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkVersion(`
                    title: version not met
                    bigipMinimumAS3: 3.23
                    template: text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /since it requires AS3 >= 3.23/));
        });
        it('bigip_version_check', function () {
            const worker = createWorker();

            const checkBigipVersion = (yamltext) => {
                let retTmpl;
                return Promise.resolve()
                    .then(() => fast.Template.loadYaml(yamltext))
                    .then((tmpl) => {
                        retTmpl = tmpl;
                        return tmpl;
                    })
                    .then(tmpl => worker.checkDependencies(tmpl, 0, false, testCtx))
                    .then(() => retTmpl);
            };

            return Promise.resolve()
                .then(() => checkBigipVersion(`
                    title: no version
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkBigipVersion(`
                    title: min version met
                    bigipMinimumVersion: 13.1
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkBigipVersion(`
                    title: min version not met
                    bigipMinimumVersion: 16.3
                    template: text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /since it requires BIG-IP >= 16.3/))
                .then(() => checkBigipVersion(`
                    title: max version met
                    bigipMaximumVersion: 16.3
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkBigipVersion(`
                    title: max version not met
                    bigipMaximumVersion: 13.1
                    template: text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /since it requires BIG-IP maximum version of 13.1/))
                .then(() => checkBigipVersion(`
                    title: min and version met
                    bigipMinimumVersion: 13.1
                    bigipMaximumVersion: 16.3
                    template: text
                `))
                .catch(e => assert(false, e.stack));
        });
        it('max_bigip_version_check', function () {
            const worker = createWorker();

            const checkBigipVersion = (yamltext) => {
                let retTmpl;
                return Promise.resolve()
                    .then(() => fast.Template.loadYaml(yamltext))
                    .then((tmpl) => {
                        retTmpl = tmpl;
                        return tmpl;
                    })
                    .then(tmpl => worker.checkDependencies(tmpl, 0, false, testCtx))
                    .then(() => retTmpl);
            };

            return Promise.resolve()
                .then(() => checkBigipVersion(`
                    title: no version
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkBigipVersion(`
                    title: version met
                    bigipMinimumVersion: 13.1
                    template: text
                `))
                .catch(e => assert(false, e.stack))
                .then(() => checkBigipVersion(`
                    title: version not met
                    bigipMinimumVersion: 16.3
                    template: text
                `))
                .then(() => assert(false, 'expected template to fail'))
                .catch(e => assert.match(e.message, /since it requires BIG-IP >= /));
        });
    });

    describe('settings', function () {
        it('post_settings', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings');
            op.setBody({
                deletedTemplateSets: [
                    'foo'
                ],
                enableIpam: true,
                ipamProviders: [
                    {
                        name: 'test',
                        password: 'foobar',
                        serviceType: 'Infoblox',
                        apiVersion: 'v2.4',
                        network: 'foo.bar'
                    }
                ]
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('Settings');
                })
                .then(() => worker.getConfig(0, testCtx))
                .then((config) => {
                    assert.deepStrictEqual(config.deletedTemplateSets, ['foo']);
                    assert(config.ipamProviders[0].password !== 'foobar', 'IPAM password was not encrypted');
                    expect(config).to.satisfySchemaInApiSpec('IpamInfoblox');
                });
        });
        it('post_settings_ipam_auth_header', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings');
            op.setBody({
                deletedTemplateSets: [
                    'foo'
                ],
                enableIpam: true,
                ipamProviders: [
                    {
                        name: 'test',
                        serviceType: 'Generic',
                        authHeaderName: 'Authorization',
                        authHeaderValue: 'Token super-secret'
                    }
                ]
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('Settings');
                })
                .then(() => worker.getConfig(0, testCtx))
                .then((config) => {
                    assert.deepStrictEqual(config.deletedTemplateSets, ['foo']);
                    assert(config.ipamProviders[0].authHeaderValue !== 'Token super-secret',
                        'IPAM auth header value was not encrypted');
                    expect(config).to.satisfySchemaInApiSpec('IpamGeneric');
                });
        });
        it('post_settings_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings');
            op.setBody({
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 422);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse422');
                });
        });
        it('patch_settings', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings');
            op.setBody({
                deletedTemplateSets: [
                    'foo'
                ],
                enableIpam: true,
                ipamProviders: [
                    { name: 'test', password: 'foobar', serviceType: 'Generic' }
                ]
            });
            return worker.onPatch(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 200);
                })
                .then(() => worker.getConfig(0, testCtx))
                .then((config) => {
                    assert.deepStrictEqual(config.deletedTemplateSets, ['foo']);
                    assert(config.ipamProviders[0].password !== 'foobar', 'IPAM password was not encrypted');
                    expect(config).to.satisfySchemaInApiSpec('IpamGeneric');
                });
        });
        it('patch_settings_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings');
            op.setBody({
                deletedTemplateSets: 5
            });
            return worker.onPatch(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 422);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse422');
                });
        });
        it('get_settings_schema', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings-schema');

            return worker.onGet(op)
                .then(() => {
                    assert.strictEqual(op.status, 200);

                    const configSchema = op.getBody();
                    console.log(JSON.stringify(configSchema, null, 2));
                    expect(configSchema).to.satisfySchemaInApiSpec('SettingsSchema');
                    assert.deepStrictEqual(configSchema.properties.deletedTemplateSets, {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                        uniqueItems: true,
                        options: {
                            hidden: true
                        },
                        // addtl props for JSONEditor
                        propertyOrder: 0,
                        format: 'table'
                    });
                });
        });
        it('get_settings', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/settings');

            return worker.onGet(op)
                .then(() => {
                    assert.strictEqual(op.status, 200);

                    const config = op.getBody();
                    console.log(JSON.stringify(config, null, 2));
                    assert.ok(config.deletedTemplateSets);
                    expect(config).to.satisfySchemaInApiSpec('Settings');
                });
        });
        it('delete_settings', function () {
            const worker = createWorker();
            const getOp = new RestOp('/shared/fast/settings');
            const deleteOp = new RestOp('/shared/fast/settings');

            return worker.getConfig(0, testCtx)
                .then((config) => {
                    config.foo = 'bar';
                })
                .then(() => worker.onGet(getOp))
                .then(() => {
                    assert.strictEqual(getOp.status, 200);
                    console.log(JSON.stringify(getOp.body, null, 2));
                    assert.ok(getOp.body.foo);
                })
                .then(() => worker.onDelete(deleteOp))
                .then(() => {
                    assert.strictEqual(deleteOp.status, 200);
                    console.log(JSON.stringify(deleteOp.body, null, 2));
                    assert.strictEqual(deleteOp.body.foo, undefined);
                });
        });
    });

    describe('info', function () {
        it('get_info', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/info');
            nock(host)
                .get('/mgmt/shared/appsvcs/info')
                .reply(200, {});

            return worker.onGet(op)
                .then(() => {
                    const info = op.body;
                    assert.strictEqual(op.status, 200);
                    console.log(JSON.stringify(info, null, 2));
                    assert.notEqual(info.installedTemplates, []);

                    const tsNames = info.installedTemplates.map(x => x.name);
                    assert(tsNames.includes('bigip-fast-templates'));
                    assert(tsNames.includes('examples'));

                    const exampleTS = info.installedTemplates.filter(
                        x => x.name === 'examples'
                    )[0];
                    assert(!exampleTS.supported, `${exampleTS.name} should not be marked as officially supported`);
                    assert(exampleTS.enabled, `${exampleTS.name} should be marked as enabled`);
                    // assert(!exampleTS.updateAvailable, `${exampleTS.name} should not have an update available`);

                    const bigipTS = info.installedTemplates.filter(
                        x => x.name === 'bigip-fast-templates'
                    )[0];
                    assert(bigipTS.supported, `${bigipTS.name} has an unsupported hash: ${bigipTS.hash}`);
                    assert(bigipTS.enabled, `${bigipTS.name} should be marked as enabled`);
                    // assert(!bigipTS.updateAvailable, `${bigipTS.name} should not have an update available`);

                    const config = info.config;
                    assert.ok(config);
                    assert.ok(config.deletedTemplateSets);
                    expect(info).to.satisfySchemaInApiSpec('Info');
                });
        });
        it('get_info_without_as3', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/info');
            nock(host)
                .get('/mgmt/shared/appsvcs/info')
                .reply(404);

            return worker.onGet(op)
                .then(() => {
                    const info = op.body;
                    assert.strictEqual(op.status, 200);
                    console.log(JSON.stringify(info, null, 2));
                    assert.notEqual(info.installedTemplates, []);

                    const tsNames = info.installedTemplates.map(x => x.name);
                    assert(tsNames.includes('bigip-fast-templates'));
                    assert(tsNames.includes('examples'));
                    expect(info).to.satisfySchemaInApiSpec('Info');
                });
        });
    });

    describe('tasks', function () {
        it('get_tasks', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/tasks');
            worker.driver._task_ids.foo1 = `${AS3DriverConstantsKey}-update-tenant-app-0-0-0-0-0`;
            nock(host)
                .get(as3TaskEp)
                .reply(200, {
                    items: [
                        {
                            id: 'foo1',
                            results: [{
                                code: 200,
                                message: 'in progress'
                            }],
                            declaration: {}
                        }
                    ]
                });
            return worker.onGet(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    assert.notEqual(op.status, 500);
                    assert.deepEqual(op.body, [{
                        _links: {
                            self: '/mgmt/shared/fast/tasks/foo1'
                        },
                        application: 'app',
                        id: 'foo1',
                        code: 200,
                        message: 'in progress',
                        name: '',
                        parameters: {},
                        tenant: 'tenant',
                        operation: 'update',
                        timestamp: new Date().toISOString(),
                        host: 'localhost'
                    }]);
                    expect(op.body).to.satisfySchemaInApiSpec('TaskList');
                });
        });
        it('get_tasks_item', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/tasks/foo1');
            worker.driver._task_ids.foo1 = `${AS3DriverConstantsKey}-update-tenant-app-0-0-0-0-0`;
            nock(host)
                .get(as3TaskEp)
                .reply(200, {
                    items: [
                        {
                            id: 'foo1',
                            results: [{
                                code: 200,
                                message: 'in progress'
                            }],
                            declaration: {}
                        }
                    ]
                });
            return worker.onGet(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    assert.notEqual(op.status, 500);
                    assert.deepEqual(op.body, {
                        application: 'app',
                        id: 'foo1',
                        code: 200,
                        message: 'in progress',
                        name: '',
                        parameters: {},
                        tenant: 'tenant',
                        operation: 'update',
                        timestamp: new Date().toISOString(),
                        host: 'localhost',
                        _links: {
                            self: '/mgmt/shared/fast/tasks/foo1'
                        }
                    });
                    expect(op.body).to.satisfySchemaInApiSpec('Task');
                });
        });
        it('get_tasks_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/tasks/foo1');
            nock(host)
                .get(as3TaskEp)
                .reply(200, {
                    items: [
                    ]
                });
            return worker.onGet(op)
                .then(() => {
                    assert.strictEqual(op.status, 404);
                });
        });
    });

    describe('offbox templates', function () {
        it('post_check_status', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/offbox-templatesets');
            op.setBody({
                methods: [
                    {
                        name: 'status'
                    }
                ]
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 3));
                    assert.equal(op.status, 200);
                    assert(op.body.code === 201);
                    assert(Array.isArray(op.body.methods));
                    expect(op.body).to.satisfySchemaInApiSpec('FastOffboxTemplatesetsResponse');
                });
        });
    });

    describe('render', function () {
        it('post_render', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/render');
            op.setBody({
                name: 'examples/simple_udp_defaults',
                parameters: {}
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 3));
                    assert.equal(op.status, 200);
                    assert(Array.isArray(op.body.message));
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationRenderedResponse');
                });
        });
        it('post_render_bad_tmplid', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/render');
            op.setBody({
                name: 'foobar/does_not_exist',
                parameters: {}
            });
            return worker.onPost(op)
                .then(() => {
                    assert.equal(op.status, 404);
                    assert.match(op.body.message, /Could not find template/);
                });
        });
        it('post_render_bad_params', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/render');
            op.setBody({
                name: 'examples/simple_udp_defaults',
                parameters: {
                    virtual_port: 'foobar'
                }
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 400);
                    assert.match(op.body.message, /Parameters failed validation/);
                });
        });
        it('post_render_bad_properties', function () {
            const worker = createWorker();
            const emptyOp = new RestOp('/shared/fast/render');
            emptyOp.setBody({});
            const nameOnlyOp = new RestOp('/shared/fast/render');
            nameOnlyOp.setBody({
                name: 'examples/simple_udp_defaults'
            });

            return worker.onPost(emptyOp)
                .then(() => {
                    console.log(JSON.stringify(emptyOp.body, null, 2));
                    assert.equal(emptyOp.status, 400);
                    assert.match(emptyOp.body.message, /name property is missing/);
                })
                .then(() => worker.onPost(nameOnlyOp))
                .then(() => {
                    console.log(JSON.stringify(nameOnlyOp.body, null, 2));
                    assert.equal(nameOnlyOp.status, 400);
                    assert.match(nameOnlyOp.body.message, /parameters property is missing/);
                });
        });
    });

    describe('templates', function () {
        it('get_templates', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templates');
            return worker.onGet(op)
                .then(() => {
                    const templates = op.body;
                    assert.notEqual(op.status, 404);
                    assert.notEqual(templates.length, 0);
                    expect(templates).to.satisfySchemaInApiSpec('TemplateNameList');
                });
        });
        it('get_template_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templates/foobar');
            return worker.onGet(op)
                .then(() => {
                    assert.equal(op.status, 404);
                });
        });
        it('get_template_item', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templates/examples/simple_udp');
            return worker.onGet(op)
                .then(() => {
                    const tmpl = op.body;
                    console.log(op.body.message);
                    assert.strictEqual(op.status, 200);
                    assert.notEqual(tmpl, {});
                    expect(tmpl).to.satisfySchemaInApiSpec('Template');
                });
        });
        it('get_template_ipam', function () {
            const worker = createWorker();
            const getOp1 = new RestOp('/shared/fast/templates/bigip-fast-templates/dns');
            const getOp2 = new RestOp('/shared/fast/templates/bigip-fast-templates/dns');

            worker.configStorage.data.config = {
                enableIpam: false
            };

            nock(host)
                .persist()
                .get(/\/mgmt\/tm\/.*/)
                .reply(200, {
                    items: []
                });
            return Promise.resolve()
                // IPAM disabled
                .then(() => worker.onGet(getOp1))
                .then(() => {
                    assert.strictEqual(getOp1.status, 200);
                    return fast.Template.fromJson(getOp1.body);
                })
                .then((tmpl) => {
                    const schema = fast.guiUtils.modSchemaForJSONEditor(tmpl.getParametersSchema());
                    const props = schema.properties;

                    assert.strictEqual(
                        props.use_ipam,
                        undefined,
                        'use_ipam is still available when IPAM is disabled'
                    );
                    assert.strictEqual(
                        props.virtual_address_ipam,
                        undefined,
                        'virtual_address_ipam is still available when IPAM is disabled'
                    );
                })
                // IPAM enabled
                .then(() => {
                    worker.configStorage.data.config.enableIpam = true;
                })
                .then(() => worker.onGet(getOp2))
                .then(() => {
                    assert.strictEqual(getOp2.status, 200);
                    return fast.Template.fromJson(getOp2.body);
                })
                .then((tmpl) => {
                    const schema = fast.guiUtils.modSchemaForJSONEditor(tmpl.getParametersSchema());
                    const props = schema.properties;

                    assert.ok(
                        props.use_ipam,
                        'use_ipam is not available when IPAM is enabled'
                    );
                    assert.ok(
                        props.virtual_address_ipam,
                        'virtual_address_ipam is not available when IPAM is enabled'
                    );
                });
        });
        it('get_template_item_with_schema', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templates/bigip-fast-templates/http');
            nock(host)
                .persist()
                .get(/mgmt\/tm\/.*/)
                .reply(200, {
                    kind: 'tm:ltm:profile:http-compression:http-compressioncollectionstate',
                    selfLink: 'https://localhost/mgmt/tm/ltm/profile/http-compression?$select=fullPath&ver=15.0.1.1',
                    items: [
                        { fullPath: '/Common/httpcompression' },
                        { fullPath: '/Common/wan-optimized-compression' }
                    ]
                });
            return worker.onGet(op)
                .then(() => {
                    const tmpl = op.body;
                    assert.equal(op.status, 200);
                    assert.notEqual(tmpl, {});
                    assert.notEqual(tmpl.getParametersSchema(), {});
                });
        });
    });

    describe('templatesets', function () {
        it('get_templatesets', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templatesets');
            return worker.onGet(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    assert.notEqual(op.status, 500);
                    const foundSets = op.body.map(x => x.name);
                    assert(foundSets.includes('bigip-fast-templates'));
                    assert(foundSets.includes('examples'));
                    assert.strictEqual(op.body[0]._links.self, '/mgmt/shared/fast/templatesets/examples');
                    assert.strictEqual(op.body[1]._links.self, '/mgmt/shared/fast/templatesets/bigip-fast-templates');
                    expect(op.body).to.satisfySchemaInApiSpec('TemplateSetList');
                });
        });
        it('get_templatesets_item', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templatesets/bigip-fast-templates');
            return worker.onGet(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    assert.notEqual(op.status, 500);

                    const ts = op.body;
                    assert.notDeepEqual(ts, {});
                    assert.strictEqual(ts.name, 'bigip-fast-templates');
                    assert.strictEqual(op.body._links.self, '/mgmt/shared/fast/templatesets/bigip-fast-templates');
                    assert.notDeepEqual(ts.templates, []);
                    expect(ts).to.satisfySchemaInApiSpec('TemplateSet');
                });
        });
        it('get_templatesets_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templatesets/foo1');
            return worker.onGet(op)
                .then(() => {
                    assert.strictEqual(op.status, 404);
                });
        });
        // run settings and templatesets last as they can interfere with the other tests
        it('post_templateset_missing', function () {
            const worker = createWorker();
            const noMatchOp = new RestOp('/shared/fast/templatesets');
            noMatchOp.setBody({
                name: 'badname'
            });
            const emptyOp = new RestOp('/shared/fast/templatesets');
            emptyOp.setBody({});

            return worker.onPost(noMatchOp)
                .then(() => assert.equal(noMatchOp.status, 404))
                .then(() => worker.onPost(emptyOp))
                .then(() => assert.equal(emptyOp.status, 400));
        });
        it('post_templateset', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templatesets');
            const infoOp = new RestOp('/shared/fast/info');

            this.clock.restore();
            op.setBody({
                name: 'testset'
            });

            nock(host)
                .get('/mgmt/shared/appsvcs/info')
                .reply(404);

            return worker.onPost(op)
                .then(() => {
                    assert(fs.existsSync(path.join(process.cwd(), 'scratch')));
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse200');
                })
                .then(() => worker.templateProvider.listSets())
                .then((tmplSets) => {
                    assert(tmplSets.includes('testset'));
                })
                .then(() => worker.onGet(infoOp))
                .then(() => {
                    assert.strictEqual(infoOp.status, 200);

                    const tsNames = infoOp.body.installedTemplates.map(x => x.name);
                    assert(tsNames.includes('testset'));
                });
        });
        it('post_templateset_github_public', function () {
            const worker = createWorker();
            this.clock.restore();

            const archivePath = path.join(__dirname, 'mockDir', 'testset.zip');
            nock('https://github.com', {
                reqheaders: {
                }
            })
                .get('/org/testset-github/archive/main.zip')
                .replyWithFile(200, archivePath)
                .get('/org/testset-github/archive/branch.zip')
                .replyWithFile(200, archivePath);

            return Promise.resolve()
                // test implicit name and branch
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitHubRepo: 'org/testset-github',
                        unprotected: true
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse200');
                })
                .then(() => worker.templateProvider.list())
                .then((templates) => {
                    assert(templates.includes('testset-github/f5_https'));
                })
                // test explicit name and branch
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitHubRepo: 'org/testset-github',
                        gitRef: 'branch',
                        unprotected: true,
                        name: 'testset-github2'
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse200');
                })
                .then(() => worker.templateProvider.list())
                .then((templates) => {
                    assert(templates.includes('testset-github2/f5_https'));
                })
                // test git data in template sets
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets/testset-github');
                    return worker.onGet(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('TemplateSet');

                    const tsData = op.body;
                    assert.ok(tsData.unprotected);
                    assert.ok(!tsData.gitToken);
                    assert.strictEqual(tsData.gitHubRepo, 'org/testset-github');
                });
        });
        it('post_templateset_github_private', function () {
            const worker = createWorker();
            this.clock.restore();

            const archivePath = path.join(__dirname, 'mockDir', 'testset.zip');
            nock('https://github.com', {
                reqheaders: {
                    authorization: 'token secret'
                }
            })
                .get('/org/testset-github/archive/main.zip')
                .replyWithFile(200, archivePath)
                .get('/org/testset-github/archive/branch.zip')
                .replyWithFile(200, archivePath);

            return Promise.resolve()
                // test implicit name and branch
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitHubRepo: 'org/testset-github',
                        gitToken: 'secret'
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse200');
                })
                .then(() => worker.templateProvider.list())
                .then((templates) => {
                    console.log(templates);
                    assert(templates.includes('testset-github/f5_https'));
                })
                // test explicit name and branch
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitHubRepo: 'org/testset-github',
                        gitRef: 'branch',
                        gitToken: 'secret',
                        name: 'testset-github2'
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse200');
                })
                .then(() => worker.templateProvider.list())
                .then((templates) => {
                    console.log(templates);
                    assert(templates.includes('testset-github2/f5_https'));
                })
                // test git data in template sets
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets/testset-github');
                    return worker.onGet(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('TemplateSet');

                    const tsData = op.body;
                    assert.ok(!tsData.unprotected);
                    assert.ok(tsData.gitToken);
                    assert.notEqual(tsData.gitToken, 'secret');
                    assert.strictEqual(tsData.gitHubRepo, 'org/testset-github');
                });
        });
        it('post_templateset_github_public_without_unprotected', function () {
            const worker = createWorker();
            this.clock.restore();

            const archivePath = path.join(__dirname, 'mockDir', 'testset.zip');
            nock('https://github.com', {
                reqheaders: {
                }
            })
                .get('/org/testset-github/archive/main.zip')
                .replyWithFile(200, archivePath)
                .get('/org/testset-github/archive/branch.zip')
                .replyWithFile(200, archivePath);

            return Promise.resolve()
                // test implicit name and branch
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitHubRepo: 'org/testset-github'
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 422);
                    assert.ok(op.body.message.match(/Must set "unprotected" boolean property/));
                })
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitHubRepo: 'org/testset-github',
                        unprotected: false
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 422);
                    assert.ok(op.body.message.match(/Must set "unprotected" boolean property/));
                });
        });
        it('post_templateset_gitlab', function () {
            const worker = createWorker();
            this.clock.restore();

            const archivePath = path.join(__dirname, 'mockDir', 'testset.zip');
            nock('https://gitlab.com', {
                reqheaders: {
                    authorization: 'Bearer secret'
                }
            })
                .get('/api/v4/projects/org%2Ftestset-gitlab/repository/archive.zip?sha=main')
                .replyWithFile(200, archivePath);

            return Promise.resolve()
                // test implicit name and branch
                .then(() => {
                    const op = new RestOp('/shared/fast/templatesets');
                    op.setBody({
                        gitLabRepo: 'org/testset-gitlab',
                        gitToken: 'secret'
                    });
                    return worker.onPost(op)
                        .then(() => op);
                })
                .then((op) => {
                    assert.equal(op.status, 200);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse200');
                })
                .then(() => worker.templateProvider.list())
                .then((templates) => {
                    console.log(templates);
                    assert(templates.includes('testset-gitlab/f5_https'));
                });
        });
        it('post_templateset_deleted', function () {
            const worker = createWorker();
            const postOp = new RestOp('/shared/fast/templatesets');
            postOp.setBody({
                name: 'examples'
            });
            const getTsOpAll1 = new RestOp('/shared/fast/templatesets?showDisabled=true');
            const getTsOpAll2 = new RestOp('/shared/fast/templatesets?showDisabled=true');
            const getTsOpEnabled = new RestOp('/shared/fast/templatesets');

            worker.storage.deleteItem('examples');
            worker.configStorage.data = {
                config: {
                    deletedTemplateSets: ['examples']
                }
            };

            const objFromSets = setList => setList.reduce((acc, curr) => {
                acc[curr.name] = curr;
                return acc;
            }, {});

            return worker.onGet(getTsOpAll1)
                .then(() => {
                    assert.equal(getTsOpAll1.status, 200);
                    console.log(JSON.stringify(getTsOpAll1.body, null, 2));

                    const sets = objFromSets(getTsOpAll1.body);
                    assert.equal(sets.examples.enabled, false);
                })
                .then(() => worker.onPost(postOp))
                .then(() => {
                    assert.equal(postOp.status, 200);
                })
                .then(() => worker.onGet(getTsOpAll2))
                .then(() => {
                    assert.equal(getTsOpAll2.status, 200);
                    console.log(JSON.stringify(getTsOpAll2.body, null, 2));

                    const sets = objFromSets(getTsOpAll2.body);
                    assert(!sets.examples, 'examples should no longer be in the disabled list');
                })
                .then(() => worker.onGet(getTsOpEnabled))
                .then(() => {
                    assert.equal(getTsOpEnabled.status, 200);
                    console.log(JSON.stringify(getTsOpEnabled.body, null, 2));

                    const sets = objFromSets(getTsOpEnabled.body);
                    assert.equal(sets.examples.enabled, true);
                })
                .then(() => worker.getConfig(0, testCtx))
                .then((config) => {
                    console.log(JSON.stringify(config, null, 2));
                    assert.deepStrictEqual(config.deletedTemplateSets, []);
                });
        });
        it('delete_templateset', function () {
            const worker = createWorker();
            const templateSet = 'bigip-fast-templates';
            const op = new RestOp(`/shared/fast/templatesets/${templateSet}`);

            return worker.templateProvider.hasSet(templateSet)
                .then(result => assert(result))
                .then(() => worker.onDelete(op))
                .then(() => assert.equal(op.status, 200))
                .then(() => worker.templateProvider.hasSet(templateSet))
                .then(result => assert(!result));
        });
        it('delete_templateset_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templatesets/does_not_exist');

            return worker.onDelete(op)
                .then(() => {
                    assert.equal(op.status, 404);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse404');
                });
        });
        it('delete_templateset_inuse', function () {
            const worker = createWorker();
            const templateSet = 'examples';
            const op = new RestOp(`/shared/fast/templatesets/${templateSet}`);
            resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(200, Object.assign({}, as3stub, {
                    tenant: {
                        class: 'Tenant',
                        app: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'examples/simple_udp_defaults'
                                }
                            }
                        },
                        app2: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'foo/bar'
                                }
                            }
                        }
                    }
                }));
            return worker.onDelete(op)
                .then(() => {
                    assert.strictEqual(op.status, 400);
                    assert.match(op.body.message, /it is being used by:\n\["tenant\/app"\]/);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse400');
                });
        });
        it('delete_all_templatesets', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/templatesets');

            return worker.onDelete(op)
                .then(() => assert.equal(op.status, 200))
                .then(() => worker.templateProvider.listSets())
                .then(setNames => assert.strictEqual(setNames.length, 0));
        });
    });

    describe('applications', function () {
        it('get_apps', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            return worker.onGet(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    assert.deepEqual(op.body, [{
                        name: 'app',
                        tenant: 'tenant',
                        template: 'foo/bar',
                        _links: {
                            self: '/mgmt/shared/fast/applications/tenant/app'
                        }
                    }, {
                        name: 'foo',
                        tenant: 'tenant',
                        template: 'foo/bar',
                        _links: {
                            self: '/mgmt/shared/fast/applications/tenant/foo'
                        }
                    }, {
                        name: 'bar',
                        tenant: 'tenant',
                        template: 'foo/bar',
                        _links: {
                            self: '/mgmt/shared/fast/applications/tenant/bar'
                        }
                    }, {
                        name: 'foobar',
                        tenant: 'tenant',
                        template: 'foo/bar',
                        _links: {
                            self: '/mgmt/shared/fast/applications/tenant/foobar'
                        }
                    }]);
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationList');
                });
        });
        it('get_apps_empty', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            as3Scope = resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(204, '');
            return worker.onGet(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    assert.deepEqual(op.body, []);
                });
        });
        it('get_apps_item_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/foobar');
            return worker.onGet(op)
                .then(() => {
                    assert.equal(op.status, 404);
                });
        });
        it('get_apps_item', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/tenant/app');
            return worker.onGet(op)
                .then(() => {
                    assert.strictEqual(op.body._links.self, '/mgmt/shared/fast/applications/tenant/app');
                    delete op.body._links;
                    assert.deepEqual(op.body, as3App);
                    expect(op.body).to.satisfySchemaInApiSpec('FastAs3App');
                });
        });
        it('post_apps_bad_tmplid', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody({
                name: 'foobar/does_not_exist',
                parameters: {}
            });
            return worker.onPost(op)
                .then(() => {
                    assert.equal(op.status, 404);
                    assert.match(op.body.message, /Could not find template/);
                });
        });
        it('post_apps_bad_tmplid_leading_slash', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody({
                name: '/examples/simple_udp_defaults',
                parameters: {}
            });
            return worker.onPost(op)
                .then(() => {
                    assert.equal(op.status, 400);
                    assert.match(op.body.message, /expected name to be of the form/);
                });
        });
        it('post_apps_bad_properties', function () {
            const worker = createWorker();
            const emptyOp = new RestOp('/shared/fast/applications');
            emptyOp.setBody({});
            const nameOnlyOp = new RestOp('/shared/fast/applications');
            nameOnlyOp.setBody({ name: 'examples/simple_udp_defaults' });
            return worker.onPost(emptyOp)
                .then(() => {
                    console.log(JSON.stringify(emptyOp.body, null, 2));
                    assert.equal(emptyOp.status, 400);
                    assert.match(emptyOp.body.message, /name property is missing/);
                })
                .then(() => worker.onPost(nameOnlyOp))
                .then(() => {
                    console.log(JSON.stringify(nameOnlyOp.body, null, 2));
                    assert.equal(nameOnlyOp.status, 400);
                    assert.match(nameOnlyOp.body.message, /parameters property is missing/);
                });
        });
        it('delete_app_bad', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/foobar');
            return worker.onDelete(op)
                .then(() => {
                    assert.equal(op.status, 404);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse404');
                });
        });
        it('delete_app', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/tenant/app');
            nock(host)
                .persist()
                .post(`${as3ep}/tenant?async=true`)
                .reply(202, {});
            return worker.onDelete(op)
                .then(() => {
                    assert.notEqual(op.status, 404);
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationDeleteResponse');
                });
        });
        it('delete_all_apps_bad_tenantfoo', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody(['tenantfoo']);
            nock(host)
                .persist()
                .post(`${as3ep}/tenant?async=true`)
                .reply(400, {});
            return worker.onDelete(op)
                .then(() => {
                    assert.strictEqual(op.status, 400);
                    console.log(op.body);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse400');
                });
        });
        it('delete_all_apps_bad_fuzz_false', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody({ fuzz: false });
            nock(host)
                .persist()
                .post(`${as3ep}/tenant?async=true`)
                .reply(400, {});
            return worker.onDelete(op)
                .then(() => {
                    assert.strictEqual(op.status, 400);
                    console.log(op.body);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse400');
                });
        });
        it('delete_all_apps_good_tenant/foo', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody(['tenant/foo']);
            nock(host)
                .persist()
                .post(`${as3ep}/tenant?async=true`)
                .reply(202, {});
            return worker.onDelete(op)
                .then(() => {
                    assert.strictEqual(op.status, 202);
                    console.log(op.body);
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationDeleteResponse');
                });
        });
        it('delete_all_apps', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            nock(host)
                .persist()
                .post(`${as3ep}/tenant?async=true`)
                .reply(202, {});
            return worker.onDelete(op)
                .then(() => {
                    assert.strictEqual(op.status, 202);
                    console.log(op.body);
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationDeleteResponse');
                });
        });
        it('patch_all_apps', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            return worker.onPatch(op)
                .then(() => {
                    assert.strictEqual(op.status, 400);
                });
        });
        it('record_user_agent', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications?userAgent=test/v1.1');
            return worker.onGet(op)
                .then(() => {
                    assert.strictEqual(
                        worker.incomingUserAgent,
                        'test/v1.1'
                    );
                    assert.strictEqual(
                        worker.driver.userAgent,
                        `test/v1.1;${worker.baseUserAgent}`
                    );
                });
        });
        it('post_apps_bad_params', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody({
                name: 'examples/simple_udp_defaults',
                parameters: {
                    virtual_port: 'foobar'
                }
            });
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 400);
                    assert.match(op.body.message, /Parameters failed validation/);
                });
        });
        it('post_apps_no_overwrite', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody({
                name: 'examples/simple_udp_defaults',
                parameters: {},
                allowOverwrite: false
            });

            resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(200, Object.assign({}, as3stub, {
                    foo: {
                        class: 'Tenant',
                        bar: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {}
                            }
                        }
                    }
                }));

            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 400);
                    assert.match(op.body.message, /application foo\/bar already exists/);
                });
        });
        it('post_apps_ipam', function () {
            const worker = createWorker();
            const ipamProvider = {
                name: 'testing',
                host: 'http://example.com',
                username: 'admin',
                password: 'password',
                retrieveUrl: '{{host}}/nextip',
                retrieveBody: '{ "num": 1}',
                retrievePathQuery: '$.addrs[0].ipv4',
                releaseUrl: '{{host}}/release/{{address}}',
                releaseBody: '{}'
            };
            worker.configStorage.data.config = {
                ipamProviders: [ipamProvider]
            };
            let retrievedAddr = '';
            let releasedAddr = '';
            const initialBody = {
                name: 'examples/simple_udp_ipam',
                parameters: {
                    use_ipam_addrs: true,
                    virtual_address_ipam: 'testing'
                }
            };
            nock('http://example.com')
                .post('/nextip', { num: 1 })
                .reply(200, { addrs: [{ ipv4: '192.0.0.0' }] })
                .post(/\/release\/.*/)
                .reply(200, (uri) => {
                    releasedAddr = uri.substr(uri.lastIndexOf('/') + 1);
                });
            nock(host)
                .persist()
                .get(as3ep)
                .query(true)
                .reply(200, as3stub);
            nock(host)
                .persist()
                .post(`${as3ep}/foo?async=true`, (body) => {
                    retrievedAddr = body.foo.bar.serviceMain.virtualAddresses[0];
                    return true;
                })
                .reply(202, {});

            const createOp = new RestOp('/shared/fast/applications');
            createOp.setBody(initialBody);
            const updateOp = new RestOp('/shared/fast/applications');
            return worker.onPost(createOp)
                .then(() => {
                    console.log(JSON.stringify(createOp.body, null, 2));
                    assert.equal(createOp.status, 202);
                    assert.strictEqual(retrievedAddr, '192.0.0.0', 'should use address from IPAM');

                    // simulate update to a non-ipam to trigger release
                    initialBody.ipamAddrs = {
                        testing: [retrievedAddr]
                    };
                    updateOp.setBody({
                        name: 'examples/simple_udp_ipam',
                        parameters: {
                            use_ipam_addrs: false,
                            virtual_address_ipam: undefined,
                            virtual_address: '10.10.1.2'
                        },
                        previousDef: initialBody
                    });

                    // manually clear the driver's pending tasks so we don't queue up the task
                    // and so we do not have to wait on a timer to clear this
                    worker.driver._pendingTasks.shift();
                    return worker.onPost(updateOp);
                })
                .then(() => {
                    console.log(JSON.stringify(updateOp.body, null, 2));
                    assert.strictEqual(releasedAddr, '192.0.0.0', 'should release previous IPAM address');
                    assert.strictEqual(retrievedAddr, '10.10.1.2', 'should update to non-IPAM address');
                });
        });
        it('post_apps', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications');
            op.setBody({
                name: 'examples/simple_udp_defaults',
                parameters: {}
            });
            nock(host)
                .persist()
                .post(`${as3ep}/foo?async=true`)
                .reply(202, {});
            return worker.onPost(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 202);
                    assert.equal(op.requestId, 1);
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationResponse');
                });
        });
        it('patch_app', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/tenant/app');
            op.setBody({
                parameters: {
                    virtual_port: 5556
                }
            });
            resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(200, Object.assign({}, as3stub, {
                    tenant: {
                        class: 'Tenant',
                        app: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'examples/simple_udp_defaults',
                                    view: {
                                        tenant_name: 'tenant',
                                        application_name: 'app',
                                        virtual_address: '192.0.2.1',
                                        virtual_port: 5555,
                                        server_addresses: ['192.0.2.2'],
                                        service_port: 5555
                                    }
                                }
                            }
                        }
                    }
                }))
                .persist()
                .post(`${as3ep}/tenant?async=true`, (body) => {
                    console.log(body);
                    assert.strictEqual(
                        body.tenant.app.serviceMain.virtualPort,
                        5556
                    );
                    return true;
                })
                .reply(202, {});

            return worker.onPatch(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 202);
                    assert.equal(op.requestId, 1);
                    expect(op.body).to.satisfySchemaInApiSpec('FastApplicationResponse');
                });
        });
        it('patch_app_bad_tenant_rename', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/tenant/app');
            op.setBody({
                parameters: {
                    tenant_name: 'tenant2',
                    virtual_port: 5556
                }
            });
            resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(200, Object.assign({}, as3stub, {
                    tenant: {
                        class: 'Tenant',
                        app: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'examples/simple_udp_defaults',
                                    view: {
                                        tenant_name: 'tenant',
                                        application_name: 'app',
                                        virtual_address: '192.0.2.1',
                                        virtual_port: 5555,
                                        server_addresses: ['192.0.2.2'],
                                        service_port: 5555
                                    }
                                }
                            }
                        }
                    }
                }))
                .persist();

            return worker.onPatch(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 422);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse422');
                });
        });
        it('patch_app_bad_app_rename', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/applications/tenant/app');
            op.setBody({
                parameters: {
                    application_name: 'app2',
                    virtual_port: 5556
                }
            });
            resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(200, Object.assign({}, as3stub, {
                    tenant: {
                        class: 'Tenant',
                        app: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'examples/simple_udp_defaults',
                                    view: {
                                        tenant_name: 'tenant',
                                        application_name: 'app',
                                        virtual_address: '192.0.2.1',
                                        virtual_port: 5555,
                                        server_addresses: ['192.0.2.2'],
                                        service_port: 5555
                                    }
                                }
                            }
                        }
                    }
                }))
                .persist();

            return worker.onPatch(op)
                .then(() => {
                    console.log(JSON.stringify(op.body, null, 2));
                    assert.equal(op.status, 422);
                    expect(op.body).to.satisfySchemaInApiSpec('FastResponse422');
                });
        });
        it('convert_pool_members', function () {
            const worker = createWorker();
            as3Scope = resetScope(as3Scope)
                .get(as3ep)
                .query(true)
                .reply(200, Object.assign({}, as3stub, {
                    tenant: {
                        class: 'Tenant',
                        http: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'bigip-fast-templates/http',
                                    view: {
                                        tenant_name: 'tenant',
                                        app_name: 'http',
                                        enable_pool: true,
                                        make_pool: true,
                                        pool_port: 80,
                                        pool_members: [
                                            '10.0.0.1'
                                        ]
                                    }
                                }
                            }
                        },
                        tcp: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'bigip-fast-templates/tcp',
                                    view: {
                                        tenant_name: 'tenant',
                                        app_name: 'tcp',
                                        enable_pool: true,
                                        make_pool: true,
                                        pool_members: [
                                            '10.0.0.2'
                                        ]
                                    }
                                }
                            }
                        },
                        tcpNew: {
                            class: 'Application',
                            constants: {
                                [AS3DriverConstantsKey]: {
                                    template: 'bigip-fast-templates/tcp',
                                    view: {
                                        enable_pool: true,
                                        make_pool: true,
                                        pool_members: [
                                            {
                                                serverAddresses: [
                                                    '10.0.0.1'
                                                ],
                                                servicePort: 389,
                                                connectionLimit: 0,
                                                priorityGroup: 0,
                                                shareNodes: true
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }))
                .persist()
                .post(`${as3ep}/tenant?async=true`)
                .reply(202, {
                    code: 202,
                    message: [
                        { id: '0' }
                    ]
                });

            nock(host)
                .persist()
                .get(/mgmt\/tm\/.*\?\$select=fullPath/)
                .reply(200, {
                    items: [
                        { fullPath: '/Common/httpcompression' },
                        { fullPath: '/Common/wan-optimized-compression' }
                    ]
                });
            const op = new RestOp('/shared/fast/applications');
            return worker.onGet(op)
                .then(() => {
                    console.log(op.body);
                    assert(as3Scope.isDone());
                });
        });
    });

    describe('bad endpoints', function () {
        it('get_bad_end_point', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/bad');
            return worker.onGet(op)
                .then(() => {
                    assert.equal(op.status, 404);
                });
        });
        it('post_bad_end_point', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/bad');
            return worker.onPost(op)
                .then(() => {
                    assert.equal(op.status, 404);
                });
        });
        it('delete_bad_end_point', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/bad');
            return worker.onDelete(op)
                .then(() => {
                    assert.equal(op.status, 404);
                });
        });
        it('patch_bad_end_point', function () {
            const worker = createWorker();
            const op = new RestOp('/shared/fast/bad');
            return worker.onPatch(op)
                .then(() => {
                    assert.equal(op.status, 404);
                });
        });
    });
});
