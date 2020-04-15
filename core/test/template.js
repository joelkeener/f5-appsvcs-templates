/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */
/* eslint-disable no-console */

'use strict';

const fs = require('fs');
const assert = require('assert').strict;

const FsSchemaProvider = require('../lib/schema_provider').FsSchemaProvider;
const Template = require('../lib/template').Template;


const templatesPath = './test/templatesets/test';

const mstWithTypes = `{
    "name" : "test template",
    "default" : "{{variable1}}",
    "string_type" : {{string_variable::string}},
    "array_type" : [
      {{#array_variable}}
        "{{.}}",
      {{/array_variable}}
    ],
    "boolean_type" : {{boolean_variable::boolean}},
    "number_type" : {{number_variable::number}},
    "duplicate_key": "{{variable1}}",
    "hidden_type": {{hidden_variable::hidden}}
`;

describe('Template class tests', function () {
    it('construct', function () {
        const tmpl = new Template();
        assert.ok(tmpl);
    });
    it('load_mustache', function () {
        const mstdata = `
            {{!
                Just a basic template
            }}
            {
                {{foo}}
            }
        `;

        return Template.loadMst(mstdata)
            .then((tmpl) => {
                assert.ok(tmpl);
                assert.strictEqual(tmpl.description, 'Just a basic template');
                assert.strictEqual(tmpl.templateText, mstdata);
                assert.strictEqual(tmpl.sourceType, 'MST');
                assert.strictEqual(tmpl.sourceText, mstdata);
                assert.strictEqual(tmpl.sourceHash, '6ac8bbb53fdfe637931e0dfc9e4259ef685ab5fc8e1e13b796dbf6d3145fe213');
            });
    });
    it('load_yaml', function () {
        const ymldata = `
            view:
              message: Hello!
            definitions:
              body:
                template:
                  <body>
                    <h1>{{message}}</h1>
                  </body>
            template: |
              <html>
                {{> body}}
              </html>
        `;

        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                assert.ok(tmpl);
                assert.strictEqual(tmpl.description, '');
                assert.deepStrictEqual(tmpl.defaultView, {
                    message: 'Hello!'
                });
                assert.deepStrictEqual(tmpl.definitions, {
                    body: {
                        template: '<body> <h1>{{message}}</h1> </body>'
                    }
                });
                assert.strictEqual(tmpl.templateText, '<html>\n  {{> body}}\n</html>\n');
                assert.strictEqual(tmpl.sourceType, 'YAML');
                assert.strictEqual(tmpl.sourceText, ymldata);
                assert.strictEqual(tmpl.sourceHash, '99223c057171b3aceb955c953a8efdf237e65e36b287138ecd953585217fe783');
                assert.strictEqual(tmpl._viewSchema, tmpl._viewSchema);
            });
    });
    it('from_json_str', function () {
        let tmpl = null;
        return Template.loadMst(mstWithTypes)
            .then((tmplData) => {
                tmpl = tmplData;
                return Template.fromJson(JSON.stringify(tmpl));
            })
            .then((jsontmpl) => {
                delete jsontmpl._viewValidator;
                delete tmpl._viewValidator;
                assert.deepEqual(jsontmpl, tmpl);
            });
    });
    it('from_json_obj', function () {
        let tmpl = null;
        return Template.loadMst(mstWithTypes)
            .then((tmplData) => {
                tmpl = tmplData;
                return Template.fromJson(JSON.parse(JSON.stringify(tmpl)));
            })
            .then((jsontmpl) => {
                delete jsontmpl._viewValidator;
                delete tmpl._viewValidator;
                assert.deepEqual(jsontmpl, tmpl);
            });
    });
    it('missing_dscription', function () {
        const mstdata = '{{{foo}}: {{bar}}}';
        return Template.loadMst(mstdata)
            .then((tmpl) => {
                assert.ok(tmpl);
                assert.strictEqual(tmpl.description, '');
            });
    });
    it('get_schema', function () {
        const reference = {
            type: 'object',
            properties: {
                variable1: { type: 'string', default: '' },
                string_variable: { type: 'string', default: '' },
                array_variable: {
                    type: 'array',
                    skip_xform: true,
                    items: {
                        default: '',
                        type: 'string'
                    },
                    default: []
                },
                boolean_variable: { type: 'boolean', default: false },
                number_variable: { type: 'number', default: 0 },
                hidden_variable: { type: 'string', format: 'hidden', default: '' }
            },
            required: [
                'variable1',
                'string_variable',
                'array_variable',
                'boolean_variable',
                'number_variable'
            ],
            title: '',
            description: '',
            definitions: {}
        };
        return Template.loadMst(mstWithTypes)
            .then((tmpl) => {
                assert.deepStrictEqual(tmpl.getViewSchema(), reference);
            });
    });
    it('load_complex_yaml', function () {
        const ymldata = fs.readFileSync(`${templatesPath}/complex.yml`, 'utf8');
        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                assert.ok(tmpl);
            });
    });
    it('fail_validation', function () {
        const mstdata = `
            {{foo}
        `;
        assert.throws(() => Template.validate(mstdata));

        // should fail for missing template, but still passes as valid mustache
        // const ymldata = 'title: foo';
        // assert.throws(() => Template.validate(ymldata));
    });
    it('schema_sections_array', function () {
        const mstdata = '{{#section}}{{foo}}{{/section}}';
        return Template.loadMst(mstdata)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert(
                    schema.required.includes('section'),
                    'section should be required'
                );
                assert(
                    !schema.required.includes('foo'),
                    'foo should not be required on base schema'
                );
                assert(
                    !Object.keys(schema.properties).includes('foo'),
                    'foo should not have been hoisted to global scope'
                );
                assert.ok(schema.dependencies);
                assert.deepStrictEqual(schema.dependencies.foo, ['section']);

                const sectionDef = schema.properties.section;
                console.log(JSON.stringify(sectionDef, null, 2));
                assert.ok(sectionDef);
                assert.strictEqual(sectionDef.type, 'array');
                assert.ok(sectionDef.items.properties.foo, 'foo variable should be nested in section');
                assert(
                    sectionDef.items.required.includes('foo'),
                    'foo variable should be required on section'
                );
            });
    });
    it('schema_sections_dot_array', function () {
        const mstdata = '{{#section}}{{.}}{{/section}}';
        return Template.loadMst(mstdata)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert(
                    schema.required.includes('section'),
                    'section should be required'
                );
                assert(!schema.dependencies, 'schema should have no dependencies');

                const sectionDef = schema.properties.section;
                console.log(JSON.stringify(sectionDef, null, 2));
                assert.ok(sectionDef);
                assert.strictEqual(sectionDef.type, 'array');
                assert.strictEqual(sectionDef.items.type, 'string');
            });
    });
    it('schema_sections_boolean', function () {
        const ymldata = `
            definitions:
                section:
                    type: "boolean"
            template: |
                {{#section}}{{foo}}{{/section}}
        `;
        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert(
                    schema.required.includes('section'),
                    'section should be required'
                );
                assert(
                    !schema.required.includes('foo'),
                    'foo should not be required on base schema'
                );
                assert.ok(schema.properties.foo, 'foo variable should have been hoisted to global scope');
                assert.ok(schema.dependencies);
                assert.deepStrictEqual(schema.dependencies.foo, ['section']);

                const sectionDef = schema.properties.section;
                console.log(JSON.stringify(sectionDef, null, 2));
                assert.ok(sectionDef);
                assert.strictEqual(sectionDef.type, 'boolean');
                assert(!sectionDef.items);
            });
    });
    it('schema_sections_object', function () {
        const ymldata = `
            definitions:
                section:
                    type: "object"
            template: |
                {{#section}}{{foo}}{{/section}}
        `;
        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert(
                    schema.required.includes('section'),
                    'section should be required'
                );
                assert(
                    !schema.required.includes('foo'),
                    'foo should not be required on base schema'
                );
                assert(
                    !Object.keys(schema.properties).includes('foo'),
                    'foo should not have been hoisted to global scope'
                );
                assert.ok(schema.dependencies);
                assert.deepStrictEqual(schema.dependencies.foo, ['section']);

                const sectionDef = schema.properties.section;
                console.log(JSON.stringify(sectionDef, null, 2));
                assert.ok(sectionDef);
                assert.strictEqual(sectionDef.type, 'object');
                assert.ok(sectionDef.properties.foo, 'foo variable should be nested in section');
                assert(
                    sectionDef.required.includes('foo'),
                    'foo variable should be required on section'
                );
            });
    });
    it('render', function () {
        const mstdata = `
            {{foo::string}}
        `;
        const view = {
            foo: 'bar'
        };
        const reference = `
            bar
        `;
        return Template.loadMst(mstdata)
            .then((tmpl) => {
                assert.strictEqual(tmpl.render(view), reference);
            });
    });
    it('load_partials', function () {
        const ymldata = fs.readFileSync(`${templatesPath}/complex.yml`, 'utf8');
        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                assert.notStrictEqual(tmpl._getPartials(), {});
            });
    });
    it('render_partial_with_type', function () {
        const ymldata = `
            view:
                numb: 5
                arr:
                    - "1"
                    - "2"
            definitions:
                numbpartial:
                    template: |
                        numb={{numb::integer}}
                arraypartial:
                    template: |
                        arr={{arr::array}}
            template: |
                {{> numbpartial}}
                {{> arraypartial}}
        `;
        const reference = 'numb=5\narr=["1","2"]\n';
        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                assert.strictEqual(tmpl.render(), reference);
            });
    });
    it('render_empty_template', function () {
        const mstdata = '';
        const view = {};
        const reference = '';

        return Template.loadMst(mstdata)
            .then((tmpl) => {
                assert.strictEqual(tmpl.render(view), reference);
            });
    });
    it('render_inverted_section', function () {
        const mstdata = '{{^skip_foo}}{{foo}}{{/skip_foo}}{{^skip_bar}}bar{{/skip_bar}}';
        const view = { skip_foo: true };
        const reference = 'bar';

        return Template.loadMst(mstdata)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert.strictEqual(tmpl.render(view), reference);
                assert.deepStrictEqual(schema.properties.foo.invertDependency, ['skip_foo']);
            });
    });
    it('render_type_defaults', function () {
        const schemaProvider = new FsSchemaProvider(templatesPath);
        const mstdata = '{{virtual_port:types:port}}';

        return Template.loadMst(mstdata, schemaProvider)
            .then((tmpl) => {
                console.log(JSON.stringify(tmpl.getViewSchema(), null, 2));
                assert.strictEqual(tmpl.definitions.port.type, 'integer');
            });
    });
    it('render_array', function () {
        const mstdata = '{{values::array}}';
        const view = { values: ['1', '2', '3'] };
        const reference = '["1","2","3"]';
        return Template.loadMst(mstdata)
            .then((tmpl) => {
                console.log(JSON.stringify(tmpl.getViewSchema(), null, 2));
                assert.strictEqual(tmpl.render(view), reference);
            });
    });
    it('render_text', function () {
        const mstdata = '{{textvar::text}}';
        const view = { textvar: 'multi\nline' };
        const reference = '"multi\\nline"';
        return Template.loadMst(mstdata)
            .then((tmpl) => {
                console.log(JSON.stringify(tmpl.getViewSchema(), null, 2));
                assert.strictEqual(tmpl.render(view), reference);
            });
    });
    it('render_merged_sections', function () {
        const ymldata = `
            definitions:
                value:
                    type: string
                part_nothing:
                    template: |
                        {{^value}}
                            Nothing
                        {{/value}}
                part_value:
                    template: |
                        {{#value}}
                            {{value}}
                        {{/value}}
            template: |
                {{> part_value}}
                {{> part_nothing}}
        `;
        const view = { value: 'foo' };
        const reference = 'foo';

        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                console.log(JSON.stringify(tmpl.getViewSchema(), null, 2));
                assert.strictEqual(tmpl.render(view).trim(), reference);
            });
    });
    it('schema_nested_sections', function () {
        const ymldata = `
            definitions:
                part:
                    template: |
                        {{^use_existing_a}}
                            {{^make_new_b}}
                                {{value}}
                            {{/make_new_b}}
                        {{/use_existing_a}}
            template: |
                {{> part}}
        `;
        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                assert.ok(tmpl);

                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert.deepStrictEqual(schema.dependencies.value, ['use_existing_a', 'make_new_b']);
            });
    });
    it('schema_clean_deps', function () {
        const mstdata = `
            {{app_name}}
            {{#do_foo}}
                {{app_name}}_foo
            {{/do_foo}}
        `;

        return Template.loadMst(mstdata)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(JSON.stringify(schema, null, 2));
                assert(schema.required.includes('app_name'));
                assert(typeof schema.dependencies === 'undefined');
            });
    });
    it('schema_title_desc_from_def', function () {
        const ymldata = `
            definitions:
                foo:
                    title: 'Foo'
                    description: 'BarBar'
                baz:
                    title: 'Baz'
                section:
                    title: 'Section'
                inv_section:
                    title: 'Inverted'
            template: |
                {{foo}}{{baz}}{{empty}}
                {{#section}}{{/section}}
                {{^inv_section}}{{/inv_section}}
        `;

        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                const fooDef = tmpl.getViewSchema().properties.foo;
                assert.strictEqual(fooDef.title, 'Foo');
                assert.strictEqual(fooDef.description, 'BarBar');

                const bazDef = tmpl.getViewSchema().properties.baz;
                assert.strictEqual(bazDef.title, 'Baz');
                assert.strictEqual(typeof bazDef.description, 'undefined');

                const emptyDef = tmpl.getViewSchema().properties.empty;
                assert.strictEqual(typeof emptyDef.title, 'undefined');
                assert.strictEqual(typeof emptyDef.description, 'undefined');

                const secDef = tmpl.getViewSchema().properties.section;
                assert.strictEqual(secDef.title, 'Section');

                const invSecDef = tmpl.getViewSchema().properties.inv_section;
                assert.strictEqual(invSecDef.title, 'Inverted');
            });
    });
    it('schema_prop_order_from_def', function () {
        const ymldata = `
            definitions:
                foo:
                    title: 'Foo'
                baz:
                    title: 'Baz'
            template: |
                {{bar}}{{baz}}{{foo}}{{other}}
        `;

        return Template.loadYaml(ymldata)
            .then((tmpl) => {
                assert.deepStrictEqual(Object.keys(tmpl.getViewSchema().properties), [
                    'foo',
                    'baz',
                    'bar',
                    'other'
                ]);
            });
    });
    it('schema_mix_types_and_defs', function () {
        const schemaProvider = new FsSchemaProvider(templatesPath);
        const ymldata = `
            definitions:
                https_port:
                    title: Foo
                    description: Very Foo
                    default: 500
            template: |
                {{https_port:types:port}}
        `;

        return Template.loadYaml(ymldata, schemaProvider)
            .then((tmpl) => {
                const schema = tmpl.getViewSchema();
                console.log(schema);

                assert.strictEqual(schema.properties.https_port.title, 'Foo');
                assert.strictEqual(schema.properties.https_port.description, 'Very Foo');
                assert.strictEqual(schema.properties.https_port.minimum, 0);
                assert.strictEqual(schema.properties.https_port.default, 500);
            });
    });
});
