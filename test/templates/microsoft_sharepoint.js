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

const util = require('./util');

const template = 'templates/bigip-fast-templates/microsoft_sharepoint.yaml';

const view = {
    tenant_name: 't1',
    app_name: 'app1',

    // virtual server
    virtual_address: '10.1.1.1',
    virtual_port: 4430,

    // http redirect
    enable_redirect: true,

    // pool spec
    enable_pool: true,
    make_pool: true,
    pool_members: [
        {
            serverAddresses: ['10.2.1.1'], servicePort: 4433, connectionLimit: 0, priorityGroup: 0, shareNodes: true
        },
        {
            serverAddresses: ['10.2.1.2'], servicePort: 4444, connectionLimit: 1000, priorityGroup: 0, shareNodes: true
        }
    ],
    load_balancing_mode: 'round-robin',
    slow_ramp_time: 300,

    // monitor spec
    monitor_fqdn: 'example.com',
    monitor_interval: 5,

    // snat
    enable_snat: true,
    snat_automap: false,
    make_snatpool: true,
    snat_addresses: ['10.3.1.1', '10.3.1.2'],

    // tls encryption profile spec
    enable_tls_server: true,
    make_tls_server_profile: true,
    tls_server_certificate: '/Common/default.crt',
    tls_server_key: '/Common/default.key',
    enable_tls_client: true,
    make_tls_client_profile: true,

    // http, xff, caching, compression, and oneconnect
    common_tcp_profile: false,
    make_tcp_profile: true,
    make_tcp_ingress_profile: true,
    make_tcp_egress_profile: true,
    tcp_ingress_topology: 'wan',
    tcp_egress_topology: 'lan',

    // analytics
    enable_analytics: true,
    make_analytics_profile: true,
    use_http_analytics_profile: false,
    use_tcp_analytics_profile: false,

    // firewall
    enable_firewall: true,
    firewall_allow_list: ['10.0.0.0/8', '11.0.0.0/8'],

    // \
    enable_waf_policy: true,
    enable_asm_logging: true,
    log_profile_names: ['log local'],

    // shape's Integrated Bot Defense
    ibd_profile_name: '/Common/bd'
};

const expected = {
    class: 'ADC',
    schemaVersion: '3.0.0',
    id: 'urn:uuid:a858e55e-bbe6-42ce-a9b9-0f4ab33e3bf7',
    t1: {
        class: 'Tenant',
        app1: {
            class: 'Application',
            template: 'generic',
            app1: {
                class: 'Service_HTTPS',
                virtualAddresses: [view.virtual_address],
                virtualPort: view.virtual_port,
                redirect80: true,
                pool: 'app1_pool',
                snat: {
                    use: 'app1_snatpool'
                },
                persistenceMethods: [],
                serverTLS: 'app1_tls_server',
                clientTLS: 'app1_tls_client',
                profileTCP: {
                    ingress: view.tcp_ingress_topology,
                    egress: view.tcp_egress_topology
                },
                profileHTTP: {
                    use: 'app1_http'
                },
                profileHTTPAcceleration: {
                    use: 'app1_caching'
                },
                profileHTTPCompression: 'basic',
                profileMultiplex: 'basic',
                profileAnalytics: {
                    use: 'app1_analytics'
                },
                profileAnalyticsTcp: {
                    use: 'app1_tcp_analytics'
                },
                policyFirewallEnforced: {
                    use: 'app1_fw_policy'
                },
                policyWAF: {
                    use: 'app1_waf_policy'
                },
                securityLogProfiles: [
                    {
                        bigip: 'log local'
                    },
                    {
                        bigip: 'log local'
                    }
                ],
                profileIntegratedBotDefense: {
                    bigip: '/Common/bd'
                }
            },
            app1_pool: {
                class: 'Pool',
                members: [{
                    servicePort: 4433,
                    serverAddresses: ['10.2.1.1'],
                    connectionLimit: 0,
                    priorityGroup: 0,
                    shareNodes: true
                },
                {
                    servicePort: 4444,
                    serverAddresses: ['10.2.1.2'],
                    connectionLimit: 1000,
                    priorityGroup: 0,
                    shareNodes: true
                }],
                loadBalancingMode: view.load_balancing_mode,
                slowRampTime: 300,
                monitors: [{
                    use: 'app1_monitor'
                }]
            },
            app1_monitor: {
                class: 'Monitor',
                monitorType: 'https',
                interval: 5,
                timeout: 16,
                send: 'GET / HTTP/1.1\r\nHost: example.com\r\nConnection: Close\r\n\r\n',
                receive: 'X-app1HealthScore: [0-5].',
                adaptive: false,
                dscp: 0,
                timeUntilUp: 0,
                targetAddress: '',
                targetPort: 0
            },
            app1_snatpool: {
                class: 'SNAT_Pool',
                snatAddresses: view.snat_addresses
            },
            app1_tls_server: {
                class: 'TLS_Server',
                certificates: [{
                    certificate: 'app1_certificate'
                }]
            },
            app1_certificate: {
                class: 'Certificate',
                certificate: { bigip: view.tls_server_certificate },
                privateKey: { bigip: view.tls_server_key }
            },
            app1_tls_client: {
                class: 'TLS_Client'
            },
            app1_http: {
                class: 'HTTP_Profile',
                xForwardedFor: true
            },
            app1_caching: {
                class: 'HTTP_Acceleration_Profile',
                parentProfile: {
                    bigip: '/Common/optimized-caching'
                },
                cacheSize: 10,
                maximumObjectSize: 2000000
            },
            app1_analytics: {
                class: 'Analytics_Profile',
                collectedStatsExternalLogging: true,
                externalLoggingPublisher: {
                    bigip: '/Common/default-ipsec-log-publisher'
                },
                capturedTrafficInternalLogging: true,
                notificationBySyslog: true,
                publishIruleStatistics: true,
                collectMaxTpsAndThroughput: true,
                collectPageLoadTime: true,
                collectClientSideStatistics: true,
                collectUserSession: true,
                collectUrl: true,
                collectGeo: true,
                collectIp: true,
                collectSubnet: true,
                collectUserAgent: true
            },
            app1_tcp_analytics: {
                class: 'Analytics_TCP_Profile',
                collectedStatsExternalLogging: true,
                externalLoggingPublisher: {
                    bigip: '/Common/default-ipsec-log-publisher'
                },
                collectRemoteHostIp: true,
                collectNexthop: true,
                collectCity: true,
                collectPostCode: true
            },
            app1_fw_allow_list: {
                class: 'Firewall_Address_List',
                addresses: [
                    '10.0.0.0/8',
                    '11.0.0.0/8'
                ]
            },
            default_fw_deny_list: {
                class: 'Firewall_Address_List',
                addresses: ['0.0.0.0/0']
            },
            app1_fw_rules: {
                class: 'Firewall_Rule_List',
                rules: [
                    {
                        protocol: 'tcp',
                        name: 'acceptTcpPackets',
                        loggingEnabled: true,
                        source: {
                            addressLists: [
                                {
                                    use: 'app1_fw_allow_list'
                                }
                            ]
                        },
                        action: 'accept'
                    },
                    {
                        protocol: 'any',
                        name: 'dropPackets',
                        loggingEnabled: true,
                        source: {
                            addressLists: [
                                {
                                    use: 'default_fw_deny_list'
                                }
                            ]
                        },
                        action: 'drop'
                    }
                ]
            },
            app1_fw_policy: {
                class: 'Firewall_Policy',
                rules: [
                    {
                        use: 'app1_fw_rules'
                    }
                ]
            },
            app1_waf_policy: {
                class: 'WAF_Policy',
                policy: {
                    text: '{ "policy": { "template": { "name": "POLICY_TEMPLATE_RAPID_DEPLOYMENT" } } }'
                },
                ignoreChanges: true
            }
        }
    }
};

describe(template, function () {
    describe('tls bridging with new pool, snatpool, and profiles', function () {
        util.assertRendering(template, view, expected);
    });

    describe('use existing analytics profile', function () {
        before(() => {
            // existing analytics profiles
            view.make_analytics_profile = false;
            view.use_http_analytics_profile = true;
            view.analytics_existing_http_profile = '/Common/analytics';
            expected.t1.app1.app1.profileAnalytics = { bigip: '/Common/analytics' };
            delete expected.t1.app1.app1_analytics;
            view.use_tcp_analytics_profile = true;
            view.analytics_existing_tcp_profile = '/Common/tcp-analytics';
            expected.t1.app1.app1.profileAnalyticsTcp = { bigip: '/Common/tcp-analytics' };
            delete expected.t1.app1.app1_tcp_analytics;
        });
    });

    describe('clean up', function () {
        util.cleanUp();
    });
});
