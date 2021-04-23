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

/* global Vue, JSONEditor */
/* eslint-env browser */
/* eslint-disable no-console */

'use strict';

// eslint-disable-next-line import/no-extraneous-dependencies
const marked = require('marked');
// eslint-disable-next-line import/no-extraneous-dependencies
const VueRouter = require('vue-router').default;

const { Template, guiUtils } = require('@f5devcentral/f5-fast-core');

const endPointUrl = '/mgmt/shared/fast';

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

const safeFetch = (uri, opts, numAttempts) => {
    numAttempts = numAttempts || 0;

    opts = Object.assign({
        // Add any defaults here
    }, opts);

    return fetch(uri, opts)
        .then(response => Promise.all([
            Promise.resolve(response),
            response.text()
        ]))
        .then(([response, textData]) => {
            let data = textData;
            let isJson = false;
            try {
                data = JSON.parse(textData);
                isJson = true;
            } catch (err) {
                console.log(`Failed to parse JSON data: ${textData}`);
            }
            if (!response.ok) {
                const retry = (
                    response.status === 404
                    && (
                        data.errorStack
                        || (data.message && data.message.match(/Public URI path not registered/))
                    )
                    && (!numAttempts || numAttempts < 5)
                );
                if (retry) {
                    numAttempts += 1;
                    console.log(`attempting retry ${numAttempts} to ${uri}`);
                    return Promise.resolve()
                        .then(() => wait(1000))
                        .then(() => safeFetch(uri, opts, numAttempts));
                }
                let msg = data;
                if (data.message) {
                    msg = data.message;
                } else if (isJson) {
                    msg = JSON.stringify(data, null, 2);
                }
                return Promise.reject(new Error(
                    `Failed to get data from ${uri}: ${response.status} ${response.statusText}\n${msg}`
                ));
            }
            return data;
        });
};
const getJSON = endPoint => safeFetch(`${endPointUrl}/${endPoint}`);

const storeSubmissionData = (data) => {
    localStorage.setItem('submission-data', JSON.stringify(data));
};

const getSubmissionData = () => {
    const submissionData = localStorage.getItem('submission-data') || '{}';
    return JSON.parse(submissionData);
};

let editor = null;

const appState = {
    debugOutput: '',
    foundAS3: true,
    as3Version: undefined,
    data: {},
    modal: {
        message: '',
        icon: ''
    },
    pageComponent: {
        template: '<div></div>'
    },
    busy: true,
    endPointUrl
};

const dispOutput = (output) => {
    if (typeof output === 'object') {
        output = JSON.stringify(output, null, 2);
    }

    if (output.length > 0) {
        console.log(output);
    }
    appState.debugOutput = output;
};

// Auto-register all components in pages directory
const requireComponent = require.context(
    './pages',
    false,
    /.*\.vue$/
);
const pageComponents = {};
requireComponent.keys().forEach((fileName) => {
    const componentConfig = requireComponent(fileName);
    const component = componentConfig.default || componentConfig;
    Vue.component(component.name, component);
    pageComponents[component.name.replace('Page', '').toLowerCase()] = component;
});

// Setup router
const routes = {};
function route(path, _pageName, pageFunc) {
    routes[`/${path}`] = { pageFunc };
}

Vue.use(VueRouter);

const router = new VueRouter({
    routes: [
        { path: '/', component: pageComponents.applications },
        { path: '/create', component: pageComponents.create },
        { path: '/modify/:appid(.*)', component: pageComponents.create },
        { path: '/resubmit/:taskid', component: pageComponents.create },
        { path: '/tasks', component: pageComponents.tasks },
        { path: '/settings', component: pageComponents.settings },
        { path: '/api', component: pageComponents.api },
        { path: '/templates', component: pageComponents.templates }
    ]
});

router.beforeEach((to, from, next) => {
    appState.busy = true;
    dispOutput('');
    next();
});

router.afterEach((to) => {
    const routePath = to.path;
    const routeInfo = routes[routePath];
    const pageFunc = (routeInfo && routeInfo.pageFunc) || (() => Promise.resolve());
    return Promise.resolve()
        .then(() => pageFunc(to.params))
        .finally(() => {
            appState.busy = false;
        });
});

let vueApp;
const multipartUpload = (file) => {
    const CHUNK_SIZE = 1000000;
    const uploadPart = (start, end) => {
        const opts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Range': `${start}-${end}/${file.size}`,
                'Content-Length': (end - start) + 1,
                Connection: 'keep-alive'
            },
            body: file.slice(start, end + 1, 'application/octet-stream')
        };
        return safeFetch(`/mgmt/shared/file-transfer/uploads/${file.name}`, opts)
            .then(() => {
                if (end === file.size - 1) {
                    return Promise.resolve();
                }
                const nextStart = start + CHUNK_SIZE;
                const nextEnd = (end + CHUNK_SIZE > file.size - 1) ? file.size - 1 : end + CHUNK_SIZE;
                return uploadPart(nextStart, nextEnd);
            })
            .catch(e => Promise.reject(new Error(`Failed to upload file: ${e.message}`)));
    };

    if (CHUNK_SIZE < file.size) {
        return uploadPart(0, CHUNK_SIZE - 1);
    }
    return uploadPart(0, file.size - 1);
};

// eslint-disable-next-line no-undef
class Base64Editor extends JSONEditor.defaults.editors.string {
    setValue(val) {
        if (val) {
            val = Buffer.from(val, 'base64').toString('utf8');
        }
        super.setValue(val);
    }

    getValue() {
        let retval = super.getValue();
        if (retval) {
            retval = Buffer.from(retval).toString('base64');
        }
        return retval;
    }
}

// eslint-disable-next-line no-undef
JSONEditor.defaults.editors.base64 = Base64Editor;

// eslint-disable-next-line no-undef
JSONEditor.defaults.resolvers.unshift((schema) => {
    if (schema.type === 'string' && schema.contentEncoding === 'base64') {
        return 'base64';
    }

    return undefined;
});

class InfoEditor extends JSONEditor.defaults.editors.info {
    build() {
        // Modify build to use getFormInputDescription() so we get descriptions
        // with the je-desc class. This allows our Markdown rendering to work with
        // the info editor
        this.options.compact = false;
        // eslint-disable-next-line no-multi-assign
        this.header = this.label = this.theme.getFormInputLabel(this.getTitle());
        this.description = this.theme.getFormInputDescription(this.schema.description || '');
        this.control = this.theme.getFormControl(this.label, this.description, null);
        this.container.appendChild(this.control);
    }
}
JSONEditor.defaults.editors.info = InfoEditor;

const createCommonEditor = (schema, defaults) => {
    const formElement = document.getElementById('form-div');
    const newEd = new JSONEditor(formElement, {
        schema,
        startval: guiUtils.filterExtraProperties(defaults, schema),
        compact: true,
        show_errors: 'always',
        disable_edit_json: true,
        disable_properties: true,
        disable_collapse: true,
        array_controls_top: true,
        theme: 'spectre',
        iconlib: 'fontawesome5'
    });

    newEd.on('ready', () => {
        // Render Markdown in descriptions
        const descElements = document.getElementsByClassName('je-desc');
        Array.prototype.map.call(descElements, (elem) => {
            // Get raw schema description since the element text has newlines stripped
            const schemaPath = elem.parentElement.parentElement.getAttribute('data-schemapath');
            const propEd = newEd.getEditor(schemaPath);
            const md = propEd.schema.description || '';

            let html = marked(md);
            if (html.startsWith('<p>')) {
                html = html.substring(3, html.length);
            }
            if (html.endsWith('</p>')) {
                html = html.substring(0, html.length - 5);
            }

            html = html.replaceAll('<a href', '<a target="_blank" href');
            elem.innerHTML = html;
        });
    });

    return newEd;
};

const newEditor = (tmplid, view, existingApp) => {
    if (editor) {
        editor.destroy();
    }

    dispOutput(`Loading template: ${tmplid}`);
    getJSON(`templates/${tmplid}`)
        .catch(e => Promise.reject(new Error(`Error loading template "${tmplid}":\n${e.message}`)))
        .then(data => Template.fromJson(data))
        .then((tmpl) => {
            // Get schema and modify it work better with JSON Editor
            const schema = guiUtils.modSchemaForJSONEditor(tmpl.getParametersSchema());

            // Create a new editor
            editor = createCommonEditor(schema, tmpl.getCombinedParameters(view));

            editor.on('ready', () => {
                dispOutput('Editor ready');
                // Enable form button now that the form is ready
                document.getElementById('view-tmpl-btn').disabled = false;
                document.getElementById('view-schema-btn').disabled = false;
                document.getElementById('view-view-btn').disabled = false;
                document.getElementById('view-render-btn').disabled = false;
                document.getElementById('btn-form-submit').disabled = false;

                if (existingApp) {
                    Object.values(editor.editors).forEach((ed) => {
                        if (ed.schema.immutable) {
                            ed.disable();
                        }
                    });
                }
            });

            editor.on('change', () => {
                document.getElementById('btn-form-submit').disabled = editor.validation_results.length !== 0;
            });

            // Hook up buttons
            document.getElementById('view-tmpl-btn').onclick = () => {
                dispOutput(tmpl.sourceText);
            };
            document.getElementById('view-schema-btn').onclick = () => {
                dispOutput(JSON.stringify(schema, null, 2));
            };
            document.getElementById('view-view-btn').onclick = () => {
                dispOutput(JSON.stringify(tmpl.getCombinedParameters(editor.getValue()), null, 2));
            };
            document.getElementById('view-render-btn').onclick = () => {
                const rendered = tmpl.render(editor.getValue());
                const msg = [
                    'WARNING: The below declaration is only for inspection and debug purposes. Submitting the ',
                    'below ouput to AS3 directly can result in loss of tenants\nand applications. Please only ',
                    'submit this declaration through FAST.\n\n',
                    rendered
                ].join('');
                dispOutput(msg);
            };
            document.getElementById('btn-form-submit').onclick = () => {
                const parameters = editor.getValue();
                const data = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: tmplid,
                        parameters
                    })
                };
                appState.busy = true;
                dispOutput(JSON.stringify(data, null, 2));
                Promise.resolve()
                    .then(() => safeFetch(`${endPointUrl}/applications`, data))
                    .then((result) => {
                        dispOutput(JSON.stringify(result, null, 2));

                        const submissionData = getSubmissionData();
                        const taskid = result.message[0].id;
                        submissionData[taskid] = {
                            template: tmplid,
                            parameters
                        };
                        storeSubmissionData(submissionData);
                    })
                    .then(() => {
                        vueApp.$router.push('tasks');
                    })
                    .catch((e) => {
                        appState.busy = false;
                        dispOutput(`Failed to submit application:\n${e.message}`);
                    });
            };

            dispOutput('Editor loaded'); // Clear text on new editor load
        })
        .catch((e) => {
            const versionError = e.message.match(/^.*since it requires AS3.*$/m);
            if (versionError) {
                dispOutput(versionError[0].replace('&gt;', '>'));
            } else {
                dispOutput(`Error loading editor:\n${e.message}`);
            }
        });
};

// Check that AS3 is available
safeFetch('/mgmt/shared/appsvcs/info')
    .then((res) => {
        appState.as3Version = res.version;
    })
    .catch((e) => {
        appState.foundAS3 = false;
        appState.busy = false;
        console.log(`Error reaching AS3: ${e.message}`);
    });

// Route functions
// TODO: Move these to page components
route('settings', 'settings', () => {
    if (editor) {
        editor.destroy();
    }

    return Promise.resolve()
        .then(() => Promise.all([
            getJSON('settings-schema'),
            getJSON('settings')
        ]))
        .then(([schema, defaults]) => {
            editor = createCommonEditor(schema, defaults);

            editor.on('ready', () => {
                document.getElementById('btn-form-submit').disabled = false;
            });

            editor.on('change', () => {
                document.getElementById('btn-form-submit').disabled = editor.validation_results.length !== 0;
            });

            document.getElementById('btn-form-submit').onclick = () => {
                const config = editor.getValue();
                const data = {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(config)
                };
                appState.busy = true;
                dispOutput('Saving settings...');
                return Promise.resolve()
                    .then(() => safeFetch(`${endPointUrl}/settings`, data))
                    .then(() => dispOutput('Settings saved successfully'))
                    .catch(e => dispOutput(`Failed to save settings:\n${e.message}`))
                    .finally(() => {
                        appState.busy = false;
                    });
            };
        })
        .catch(e => dispOutput(e.message));
});
route('templates', 'templates', () => {
    const filters = {
        enabled: 'Enabled',
        f5: 'F5 Supported',
        disabled: 'Disabled',
        all: 'All Template Sets'
    };
    const templatesFilterKey = 'templates-filter';
    let currentFilter = localStorage.getItem(templatesFilterKey);
    if (!currentFilter) {
        currentFilter = 'enabled';
    }

    const renderTemplates = () => Promise.resolve()
        .then(() => Promise.all([
            getJSON('applications'),
            getJSON('templatesets'),
            getJSON('templatesets?showDisabled=true')
        ]))
        .then(([applications, templatesets, disabledTemplateSets]) => {
            const allTemplates = templatesets
                .concat(disabledTemplateSets)
                .filter(x => (
                    (currentFilter === 'all')
                    || (currentFilter === 'f5' && x.supported)
                    || (currentFilter === 'enabled' && x.enabled)
                    || (currentFilter === 'disabled' && !x.enabled)
                ));

            // build dictionary of app lists, keyed by set
            const appDict = applications.reduce((acc, curr) => {
                const setName = curr.template.split('/')[0];
                if (!acc[setName]) {
                    acc[setName] = [];
                }
                acc[setName].push(curr);
                return acc;
            }, {});

            const setMap = allTemplates.reduce((acc, curr) => {
                const apps = appDict[curr.name] || [];
                acc[curr.name] = Object.assign(curr, {
                    expanded: apps.length < 3,
                    apps
                });
                return acc;
            }, {});

            appState.data.sets = setMap;
            Object.values(setMap).forEach((setData) => {
                if (!setData.enabled && setData.updateAvailable) {
                    console.error('enabled === false && updateAvailable is illegal. Critical Error');
                }
            });

            appState.data.errors = disabledTemplateSets.reduce((acc, curr) => {
                if (curr.error) {
                    acc.push(curr.error);
                }
                return acc;
            }, []);
        })
        .then(() => dispOutput(''));

    const reloadTemplates = () => Promise.resolve()
        .then(() => {
            appState.busy = true;
        })
        .then(() => renderTemplates())
        .then(() => {
            appState.busy = false;
        });

    document.getElementById('btn-add-ts').onclick = () => {
        document.getElementById('input-ts-file').click();
    };
    document.getElementById('input-ts-file').onchange = () => {
        const file = document.getElementById('input-ts-file').files[0];
        const tsName = file.name.slice(0, -4);
        appState.busy = true;
        dispOutput(`Uploading file: ${file.name}`);
        multipartUpload(file)
            .then(() => dispOutput(`Installing template set ${tsName}`))
            .then(() => safeFetch('/mgmt/shared/fast/templatesets', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: file.name.slice(0, -4)
                })
            }))
            .then(() => {
                dispOutput(`${tsName} installed successfully`);
            })
            .then(() => reloadTemplates())
            .catch((e) => {
                appState.busy = false;
                dispOutput(`Failed to install ${tsName}:\n${e.message}`);
            });
    };
    document.getElementById('btn-delete-all-ts').onclick = () => {
        vueApp.showModal(
            'warning',
            'All Template Sets will be removed!',
            () => {
                appState.busy = true;
                dispOutput('Deleting All Template Sets');
                return safeFetch(`${endPointUrl}/templatesets`, {
                    method: 'DELETE'
                })
                    .then(() => {
                        dispOutput('All Template Sets deleted successfully');
                    })
                    .then(() => reloadTemplates())
                    .catch((e) => {
                        appState.busy = false;
                        dispOutput(`Failed to delete all Template Sets. Error: ${e.message}`);
                    });
            }
        );
    };

    vueApp.$refs.page.setFilter = (filter) => {
        currentFilter = filter;
        appState.data.currentFilter = filter;
        localStorage.setItem(templatesFilterKey, filter);
        document.getElementById('templates-filter').classList.remove('active'); // Collapse the drop down
        reloadTemplates();
    };

    vueApp.$refs.page.removeSet = (setName) => {
        vueApp.showModal(
            'warning',
            `Template Set '${setName}' will be removed!`,
            () => {
                appState.busy = true;
                dispOutput(`Deleting ${setName}`);
                return Promise.resolve()
                    .then(() => safeFetch(`${endPointUrl}/templatesets/${setName}`, {
                        method: 'DELETE'
                    }))
                    .then(() => {
                        dispOutput(`${setName} deleted successfully`);
                    })
                    .then(() => reloadTemplates())
                    .catch((err) => {
                        appState.busy = false;
                        dispOutput(`Failed to delete ${setName}:\n${err.message}`);
                    });
            }
        );
    };

    vueApp.$refs.page.installSet = (setName) => {
        vueApp.showModal(
            'info',
            `Template Set '${setName}' will be enabled.`,
            () => {
                appState.busy = true;
                dispOutput(`Enabling ${setName}`);
                return Promise.resolve()
                    .then(() => safeFetch(`${endPointUrl}/templatesets`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            name: setName
                        })
                    }))
                    .then(() => {
                        dispOutput(`${setName} enabled successfully`);
                    })
                    .then(() => reloadTemplates())
                    .catch((err) => {
                        appState.busy = false;
                        dispOutput(`Failed to enable ${setName}:\n${err.message}`);
                    });
            }
        );
    };

    vueApp.$refs.page.updateSet = (setName) => {
        vueApp.showModal(
            'warning',
            `Template Set '${setName}' will be updated!`,
            () => {
                appState.busy = true;
                dispOutput(`Updating ${setName}`);
                return Promise.resolve()
                    .then(() => safeFetch(`${endPointUrl}/templatesets`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            name: setName
                        })
                    }))
                    .then(() => {
                        dispOutput(`${setName} installed successfully`);
                    })
                    .then(() => reloadTemplates())
                    .catch((err) => {
                        appState.busy = false;
                        dispOutput(`Failed to install ${setName}:\n${err.message}`);
                    });
            }
        );
    };

    appState.data = {
        filters,
        currentFilter,
        sets: [],
        apps: {},
        errors: []
    };

    return renderTemplates();
});

// Create and mount Vue app
vueApp = new Vue({
    data: appState,
    router,
    methods: {
        cancelModal() {
            appState.modal.message = '';
        },
        continueModal() {
            const modalFunc = window.modalFunc || Promise.resolve();
            Promise.resolve()
                .then(() => modalFunc())
                .finally(() => this.cancelModal());
        },
        showModal(type, msg, func) {
            if (type === 'warning') {
                appState.modal.icon = 'info-warning';
                appState.modal.title = 'Warning';
            } else {
                appState.modal.icon = 'info-circle';
                appState.modal.title = 'Info';
            }
            window.modalFunc = func;
            appState.modal.message = msg;
        },
        safeFetch(uri, opts, numAttempts) {
            return safeFetch(uri, opts, numAttempts);
        },
        getJSON(path) {
            return getJSON(path);
        },
        dispOutput(msg) {
            return dispOutput(msg);
        },
        getSubmissionData() {
            return getSubmissionData();
        },
        storeSubmissionData(data) {
            return storeSubmissionData(data);
        },
        newEditor(tmplid, view, existingApp) {
            return newEditor(tmplid, view, existingApp);
        },
        destroyEditor() {
            if (editor) {
                editor.destroy();
            }
        }
    }
});
vueApp.$mount('#vue-app');
