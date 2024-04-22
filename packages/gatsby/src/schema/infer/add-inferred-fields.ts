// eslint-disable-next-line @typescript-eslint/naming-convention
import _ from "lodash"
import { ObjectTypeComposer } from "graphql-compose"
import { GraphQLList } from "graphql"
import invariant from "invariant"
import report from "gatsby-cli/lib/reporter"

import { isFile } from "./is-file"
import { isDate } from "../types/date"
import { addDerivedType } from "../types/derived-types"
import { reportOnce } from "../../utils/report-once"
import { is32BitInteger } from "../../utils/is-32-bit-integer"
import { getDataStore } from "../../datastore"
import type { IGatsbyNode } from "../../internal"

const deprecatedNodeKeys = new Set()

export function addInferredFields({
  schemaComposer,
  typeComposer,
  exampleValue,
  typeMapping,
}): void {
  const config = getInferenceConfig({
    typeComposer,
    defaults: {
      shouldAddFields: true,
    },
  })
  addInferredFieldsImpl({
    schemaComposer,
    typeComposer,
    exampleObject: exampleValue,
    prefix: typeComposer.getTypeName(),
    unsanitizedFieldPath: [typeComposer.getTypeName()],
    typeMapping,
    config,
  })

  if (deprecatedNodeKeys.size > 0) {
    const plugin = typeComposer.getExtension(`plugin`)

    reportOnce(
      `Plugin "${plugin}" is using the ___NODE convention which is deprecated. This plugin should use the @link directive instead.\nMigration: https://gatsby.dev/node-convention-deprecation`,
      `verbose`,
    )
  }
}

function addInferredFieldsImpl({
  schemaComposer,
  typeComposer,
  exampleObject,
  typeMapping,
  prefix,
  unsanitizedFieldPath,
  config,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  const fields: Array<{
    key: string
    unsanitizedKey: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exampleValue: any
  }> = []
  Object.keys(exampleObject).forEach((unsanitizedKey) => {
    const key = createFieldName(unsanitizedKey)
    fields.push({
      key,
      unsanitizedKey,
      exampleValue: exampleObject[unsanitizedKey],
    })
  })

  const fieldsByKey = _.groupBy(fields, (field) => field.key)

  Object.keys(fieldsByKey).forEach((key) => {
    const possibleFields = fieldsByKey[key]
    let selectedField
    if (possibleFields.length > 1) {
      const field = resolveMultipleFields(possibleFields)
      const possibleFieldsNames = possibleFields
        .map((field) => `\`${field.unsanitizedKey}\``)
        .join(`, `)
      report.warn(
        `Multiple node fields resolve to the same GraphQL field \`${prefix}.${field.key}\` - [${possibleFieldsNames}]. Gatsby will use \`${field.unsanitizedKey}\`.`,
      )
      selectedField = field
    } else {
      selectedField = possibleFields[0]
    }

    const fieldConfig = getFieldConfig({
      ...selectedField,
      schemaComposer,
      typeComposer,
      prefix,
      unsanitizedFieldPath,
      typeMapping,
      config,
    })

    if (!fieldConfig) return

    if (!typeComposer.hasField(key)) {
      if (config.shouldAddFields) {
        typeComposer.addFields({ [key]: fieldConfig })
        typeComposer.setFieldExtension(key, `createdFrom`, `inference`)
      }
    }
  })

  return typeComposer
}

function getFieldConfig({
  schemaComposer,
  typeComposer,
  prefix,
  exampleValue,
  key,
  unsanitizedKey,
  unsanitizedFieldPath,
  typeMapping,
  config,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  const selector = `${prefix}.${key}`
  unsanitizedFieldPath.push(unsanitizedKey)

  let arrays = 0
  let value = exampleValue
  while (Array.isArray(value)) {
    value = value[0]
    arrays++
  }

  let fieldConfig
  if (hasMapping(typeMapping, selector)) {
    // TODO: Use `prefix` instead of `selector` in hasMapping and getFromMapping?
    // i.e. does the config contain sanitized field names?
    fieldConfig = getFieldConfigFromMapping({ typeMapping, selector })
  } else if (unsanitizedKey.includes(`___NODE`)) {
    // TODO(v5): Remove ability to use foreign keys like this (e.g. author___NODE___contact___email)
    // and recommend using schema customization instead
    fieldConfig = getFieldConfigFromFieldNameConvention({
      schemaComposer,
      value: exampleValue,
      key: unsanitizedKey,
    })
    arrays = arrays + (value.multiple ? 1 : 0)

    deprecatedNodeKeys.add(unsanitizedKey)
  } else {
    fieldConfig = getSimpleFieldConfig({
      schemaComposer,
      typeComposer,
      key,
      value,
      selector,
      unsanitizedFieldPath,
      typeMapping,
      config,
      arrays,
    })
  }

  unsanitizedFieldPath.pop()
  if (!fieldConfig) return null

  // Proxy resolver to unsanitized fieldName in case it contained invalid characters
  if (key !== unsanitizedKey.split(`___NODE`)[0]) {
    fieldConfig = {
      ...fieldConfig,
      extensions: {
        ...(fieldConfig.extensions || {}),
        proxy: { from: unsanitizedKey },
      },
    }
  }

  while (arrays > 0) {
    fieldConfig = { ...fieldConfig, type: [fieldConfig.type] }
    arrays--
  }

  return fieldConfig
}

function resolveMultipleFields(
  possibleFields: Array<{ key: string; unsanitizedKey: string }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const nodeField = possibleFields.find((field) => {
    return field.unsanitizedKey.includes(`___NODE`)
  })
  if (nodeField) {
    return nodeField
  }

  const canonicalField = possibleFields.find(
    (field) => field.unsanitizedKey === field.key,
  )
  if (canonicalField) {
    return canonicalField
  }

  return _.sortBy(possibleFields, (field) => field.unsanitizedKey)[0]
}

// XXX(freiksenet): removing this as it's a breaking change
// Deeper nested levels should be inferred as JSON.
// const MAX_DEPTH = 5

function hasMapping(mapping, selector): boolean {
  return mapping && Object.keys(mapping).includes(selector)
}

function getFieldConfigFromMapping({
  typeMapping,
  selector,
}: {
  typeMapping: { [key: string]: string }
  selector: string
}): {
  type: string
  extensions: { link: { by: string } }
} {
  const [type, ...path] = typeMapping[selector].split(`.`)
  return {
    type,
    extensions: {
      link: { by: path.join(`.`) || `id` },
    },
  }
}

// probably should be in example value
function getFieldConfigFromFieldNameConvention({
  schemaComposer,
  value,
  key,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemaComposer: any
  value: { linkedNodes: Array<string> }
  key: string
}): { type: string; extensions: { link: { by: string; from: string } } } {
  const path = key.split(`___NODE___`)[1]
  // Allow linking by nested fields, e.g. `author___NODE___contact___email`
  const foreignKey = path && path.replace(/___/g, `.`)
  const linkedTypesSet = new Set()

  if (foreignKey) {
    const linkedValues = new Set<string>(value.linkedNodes)

    getDataStore()
      .iterateNodes()
      .forEach((node: IGatsbyNode): void => {
        const value = _.get(node, foreignKey)
        if (linkedValues.has(value as string)) {
          linkedTypesSet.add(node.internal.type)
        }
      })
  } else {
    value.linkedNodes.forEach((id) => {
      const node = getDataStore().getNode(id)
      if (node) {
        linkedTypesSet.add(node.internal.type)
      }
    })
  }

  const linkedTypes = [...linkedTypesSet]

  invariant(
    linkedTypes.length,
    `Encountered an error trying to infer a GraphQL type for: \`${key}\`. ` +
      `There is no corresponding node with the \`id\` field matching: "${value.linkedNodes}".`,
  )

  let type
  // If the field value is an array that links to more than one type,
  // create a GraphQLUnionType. Note that we don't support the case where
  // scalar fields link to different types. Similarly, an array of objects
  // with foreign-key fields will produce union types if those foreign-key
  // fields are arrays, but not if they are scalars. See the tests for an example.
  if (linkedTypes.length > 1) {
    const typeName = linkedTypes.sort().join(``) + `Union`
    type = schemaComposer.getOrCreateUTC(typeName, (utc) => {
      utc.setTypes(
        linkedTypes.map((typeName) => schemaComposer.getOTC(typeName)),
      )
      utc.setResolveType((node) => node.internal.type)
    })
  } else {
    type = linkedTypes[0]
  }

  return {
    type,
    extensions: {
      link: { by: foreignKey || `id`, from: key },
    },
  }
}

function getSimpleFieldConfig({
  schemaComposer,
  typeComposer,
  key,
  value,
  selector,
  unsanitizedFieldPath,
  typeMapping,
  config,
  arrays,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemaComposer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeComposer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selector: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unsanitizedFieldPath: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeMapping: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arrays: any
}):
  | {
      type: string
      extensions: {
        dateformat: Record<string, unknown>
        fileByRelativePath?: undefined
      }
    }
  | {
      type: string
      extensions: {
        fileByRelativePath: Record<string, unknown>
        dateformat?: undefined
      }
    }
  | { type: string; extensions?: undefined }
  | null {
  switch (typeof value) {
    case `boolean`:
      return { type: `Boolean` }
    case `number`:
      return { type: is32BitInteger(value) ? `Int` : `Float` }
    case `string`:
      if (isDate(value)) {
        return { type: `Date`, extensions: { dateformat: {} } }
      }
      if (isFile(unsanitizedFieldPath, value)) {
        // NOTE: For arrays of files, where not every path references
        // a File node in the db, it is semi-random if the field is
        // inferred as File or String, since the exampleValue only has
        // the first entry (which could point to an existing file or not).
        return { type: `File`, extensions: { fileByRelativePath: {} } }
      }
      return { type: `String` }
    case `object`:
      if (value instanceof Date) {
        return { type: `Date`, extensions: { dateformat: {} } }
      }
      if (value instanceof String) {
        return { type: `String` }
      }
      if (value /* && depth < MAX_DEPTH*/) {
        let fieldTypeComposer
        if (typeComposer.hasField(key)) {
          fieldTypeComposer = typeComposer.getFieldTC(key)
          // If we have an object as a field value, but the field type is
          // explicitly defined as something other than an ObjectType
          // we can bail early.
          if (!(fieldTypeComposer instanceof ObjectTypeComposer)) return null
          // If the array depth of the field value and of the explicitly
          // defined field type don't match we can also bail early.
          let lists = 0
          let fieldType = typeComposer.getFieldType(key)
          while (fieldType.ofType) {
            if (fieldType instanceof GraphQLList) lists++
            fieldType = fieldType.ofType
          }
          if (lists !== arrays) return null
        } else {
          // When the field type has not been explicitly defined, we
          // don't need to continue in case of @dontInfer
          if (!config.shouldAddFields) return null

          const typeName = createTypeName(selector)
          if (schemaComposer.has(typeName)) {
            // Type could have been already created via schema customization
            fieldTypeComposer = schemaComposer.getOTC(typeName)
          } else {
            fieldTypeComposer = ObjectTypeComposer.create(
              typeName,
              schemaComposer,
            )
            fieldTypeComposer.setExtension(`createdFrom`, `inference`)
            fieldTypeComposer.setExtension(
              `plugin`,
              typeComposer.getExtension(`plugin`),
            )
            addDerivedType({
              typeComposer,
              derivedTypeName: fieldTypeComposer.getTypeName(),
            })
          }
        }

        // Inference config options are either explicitly defined on a type
        // with directive/extension, or inherited from the parent type.
        const inferenceConfig = getInferenceConfig({
          typeComposer: fieldTypeComposer,
          defaults: config,
        })

        return {
          type: addInferredFieldsImpl({
            schemaComposer,
            typeComposer: fieldTypeComposer,
            exampleObject: value,
            typeMapping,
            prefix: selector,
            unsanitizedFieldPath,
            config: inferenceConfig,
          }),
        }
      }
  }
  throw new Error(`Can't determine type for "${value}" in \`${selector}\`.`)
}

function createTypeName(selector: string): string {
  const keys = selector.split(`.`)
  const suffix = keys.slice(1).map(_.upperFirst).join(``)
  return `${keys[0]}${suffix}`
}

const NON_ALPHA_NUMERIC_EXPR = new RegExp(`[^a-zA-Z0-9_]`, `g`)

/**
 * GraphQL field names must be a string and cannot contain anything other than
 * alphanumeric characters and `_`. They also can't start with `__` which is
 * reserved for internal fields (`___foo` doesn't work either).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createFieldName(key: string): any {
  // Check if the key is really a string otherwise GraphQL will throw.
  invariant(
    typeof key === `string`,
    `GraphQL field name (key) is not a string: \`${key}\`.`,
  )

  const fieldName = key.split(`___NODE`)[0]
  const replaced = fieldName.replace(NON_ALPHA_NUMERIC_EXPR, `_`)

  // key is invalid; normalize with leading underscore and rest with x
  if (replaced.match(/^__/)) {
    return replaced.replace(/_/g, (_char, index) => (index === 0 ? `_` : `x`))
  }

  // key is invalid (starts with numeric); normalize with leading underscore
  if (replaced.match(/^[0-9]/)) {
    return `_` + replaced
  }

  return replaced
}

function getInferenceConfig({
  typeComposer,
  defaults,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeComposer: any
  defaults: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shouldAddFields: any
  }
}): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldAddFields: any
} {
  return {
    shouldAddFields: typeComposer.hasExtension(`infer`)
      ? typeComposer.getExtension(`infer`)
      : defaults.shouldAddFields,
  }
}
