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

const template = 'templates/bigip-fast-templates/dns.yaml';

const view = {
    tenant_name: 't1',
    app_name: 'app1',

    // virtual server
    virtual_address: '10.1.1.1',
    virtual_port: 4430,

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

    // monitor
    monitor_interval: 30,
    monitor_queryName: 'dns.example.com',
    monitor_queryType: 'a',
    monitor_receive: '10.3.3.3',

    // snat
    enable_snat: true,
    snat_automap: false,
    snat_addresses: ['10.3.1.1', '10.3.1.2'],

    // irule
    tcp_irule_names: ['example_tcp_irule'],
    udp_irule_names: ['example_udp_irule'],

    // analytics
    enable_analytics: true,
    make_analytics_profile: true,

    // firewall
    enable_firewall: true,
    firewall_allow_list: ['10.0.0.0/8', '11.0.0.0/8'],

    // asm
    enable_waf_policy: true,
    enable_asm_logging: true,
    log_profile_names: ['log local']
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
            app1_tcp: {
                class: 'Service_TCP',
                virtualAddresses: [view.virtual_address],
                virtualPort: view.virtual_port,
                pool: 'app1_pool',
                snat: {
                    use: 'app1_snatpool'
                },
                profileTCP: {
                    ingress: 'wan',
                    egress: 'lan'
                },
                iRules: [
                    {
                        bigip: 'example_tcp_irule'
                    }
                ],
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
                ]
            },
            app1_udp: {
                class: 'Service_UDP',
                virtualAddresses: [view.virtual_address],
                virtualPort: view.virtual_port,
                pool: 'app1_pool',
                snat: {
                    use: 'app1_snatpool'
                },
                iRules: [
                    {
                        bigip: 'example_udp_irule'
                    }
                ],
                profileUDP: {
                    bigip: '/Common/udp_gtm_dns'
                },
                profileDNS: {
                    bigip: '/Common/dns'
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
                ]
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
                monitorType: 'dns',
                interval: 30,
                timeout: 91,
                queryName: 'dns.example.com',
                queryType: 'a',
                receive: '10.3.3.3'
            },
            app1_snatpool: {
                class: 'SNAT_Pool',
                snatAddresses: view.snat_addresses
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
                        protocol: 'udp',
                        name: 'acceptUdpPackets',
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
    describe('new pool, snatpool, and profiles', function () {
        util.assertRendering(template, view, expected);
    });

    describe('default pool port, existing monitor, snatpool, and profiles', function () {
        before(() => {
            // default https pool port and existing monitor
            console.log(JSON.stringify(view.pool_members));
            view.pool_members[0].servicePort = 80;
            expected.t1.app1.app1_pool.members[0].servicePort = 80;
            delete view.monitor_interval;
            delete view.monitor_queryName;
            delete view.monitor_queryType;
            delete view.monitor_receive;
            view.make_monitor = false;
            view.monitor_name = '/Common/monitor1';
            delete expected.t1.app1.app1_monitor;
            expected.t1.app1.app1_pool.monitors = [{ bigip: '/Common/monitor1' }];

            // existing analytics profiles
            view.make_analytics_profile = false;
            view.analytics_existing_tcp_profile = '/Common/tcp-analytics';
            expected.t1.app1.app1_tcp.profileAnalyticsTcp = { bigip: '/Common/tcp-analytics' };
            delete expected.t1.app1.app1_tcp_analytics;
        });
        util.assertRendering(template, view, expected);
    });

    describe('no monitor', function () {
        before(() => {
            delete view.monitor_name;
            view.enable_monitor = false;
            delete expected.t1.app1.app1_pool.monitors;
        });
        util.assertRendering(template, view, expected);
    });

    describe('existing pool, snat automap and default profiles', function () {
        before(() => {
            // default https virtual port
            delete view.virtual_port;
            expected.t1.app1.app1_tcp.virtualPort = 53;
            expected.t1.app1.app1_udp.virtualPort = 53;

            // existing pool
            delete view.pool_members;
            delete view.load_balancing_mode;
            delete view.slow_ramp_time;
            view.make_pool = false;
            view.pool_name = '/Common/pool1';
            delete expected.t1.app1.app1_pool;
            expected.t1.app1.app1_tcp.pool = { bigip: '/Common/pool1' };
            expected.t1.app1.app1_udp.pool = { bigip: '/Common/pool1' };

            // snat automap
            view.snat_automap = true;
            delete expected.t1.app1.app1_snatpool;
            expected.t1.app1.app1_tcp.snat = 'auto';
            expected.t1.app1.app1_udp.snat = 'auto';
        });
        util.assertRendering(template, view, expected);
    });

    describe('existing pool, snat automap and default profiles', function () {
        before(() => {
            // default https virtual port
            delete view.virtual_port;
            expected.t1.app1.app1_tcp.virtualPort = 53;
            expected.t1.app1.app1_udp.virtualPort = 53;

            // existing pool
            view.make_pool = false;
            view.pool_name = '/Common/pool1';
            delete expected.t1.app1.app1_pool;
            expected.t1.app1.app1_tcp.pool = { bigip: '/Common/pool1' };
            expected.t1.app1.app1_udp.pool = { bigip: '/Common/pool1' };

            // snat automap
            view.snat_automap = true;
            delete expected.t1.app1.app1_snatpool;
            expected.t1.app1.app1_tcp.snat = 'auto';
            expected.t1.app1.app1_udp.snat = 'auto';
        });
        util.assertRendering(template, view, expected);
    });

    describe('no pool', function () {
        before(() => {
            // existing pool
            delete view.pool_name;
            view.enable_pool = false;
            delete expected.t1.app1.app1_tcp.pool;
            delete expected.t1.app1.app1_udp.pool;
        });
        util.assertRendering(template, view, expected);
    });

    describe('clean up', function () {
        util.cleanUp();
    });
});
