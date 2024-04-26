import {
  getNamedType,
  getNullableType,
  GraphQLInputObjectType,
  GraphQLList,
  type GraphQLInputFieldMap,
} from "graphql";
import { addDerivedType } from "./derived-types";
import {
  SchemaComposer,
  EnumTypeComposer,
  ObjectTypeComposer,
  InputTypeComposer,
  InterfaceTypeComposer,
  UnionTypeComposer,
  ScalarTypeComposer,
  toInputObjectType,
  ListComposer,
} from "graphql-compose";

import { convertToNestedInputType, type IVisitContext } from "./utils";

type AnyTypeComposer<TContext> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ObjectTypeComposer<any, TContext>
  | InputTypeComposer<TContext>
  | EnumTypeComposer<TContext>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | InterfaceTypeComposer<any, TContext>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | UnionTypeComposer<any, TContext>
  | ScalarTypeComposer<TContext>;

export const SORTABLE_ENUM = {
  SORTABLE: "SORTABLE",
  NOT_SORTABLE: "NOT_SORTABLE",
  DEPRECATED_SORTABLE: "DEPRECATED_SORTABLE",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSortOrderEnum<TContext = any>({
  schemaComposer,
}: {
  schemaComposer: SchemaComposer<TContext>;
}): EnumTypeComposer<TContext> {
  return schemaComposer.getOrCreateETC("SortOrderEnum", (etc) => {
    etc.setFields({
      ASC: { value: "ASC" },
      DESC: { value: "DESC" },
    });
  });
}

const MAX_SORT_DEPTH = 3;
const SORT_FIELD_DELIMITER = "___";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convert<TContext = any>({
  schemaComposer,
  typeComposer,
  fields,
  prefix = null,
  depth = 0,
  deprecationReason: parentFieldDeprecationReason,
}: {
  schemaComposer: SchemaComposer<TContext>;
  typeComposer: AnyTypeComposer<TContext>;
  fields: GraphQLInputFieldMap;
  prefix?: string | null | undefined;
  depth?: number | undefined;
  deprecationReason?: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  const sortFields = {};

  Object.keys(fields).forEach((fieldName) => {
    let deprecationReason = parentFieldDeprecationReason;
    const fieldConfig = fields[fieldName];
    const sortable =
      typeComposer instanceof UnionTypeComposer ||
      typeComposer instanceof ScalarTypeComposer
        ? undefined
        : typeComposer.getFieldExtension(fieldName, "sortable");
    if (sortable === SORTABLE_ENUM.NOT_SORTABLE) {
      return;
    } else if (sortable === SORTABLE_ENUM.DEPRECATED_SORTABLE) {
      deprecationReason =
        "Sorting on fields that need arguments to resolve is deprecated.";
    }
    const sortKey = prefix ? `${prefix}.${fieldName}` : fieldName;
    const sortKeyFieldName = sortKey.split(".").join(SORT_FIELD_DELIMITER);

    // XXX(freiksenet): this is to preserve legacy behaviour, this probably doesn't actually sort
    if (getNullableType(fieldConfig.type) instanceof GraphQLList) {
      sortFields[sortKeyFieldName] = {
        value: sortKey,
        deprecationReason,
      };
    }

    const type = getNamedType(fieldConfig.type);
    if (type instanceof GraphQLInputObjectType) {
      if (depth < MAX_SORT_DEPTH) {
        const typeComposer = schemaComposer.getAnyTC(
          type.name.replace(/Input$/, ""),
        );
        Object.assign(
          sortFields,
          convert({
            schemaComposer,
            typeComposer,
            fields: type.getFields(),
            prefix: sortKey,
            depth: depth + 1,
            deprecationReason,
          }),
        );
      }
    } else {
      // GraphQLScalarType || GraphQLEnumType
      sortFields[sortKeyFieldName] = {
        value: sortKey,
        deprecationReason,
      };
    }
  });
  return sortFields;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getFieldsEnum<TSource = any, TContext = any>({
  schemaComposer,
  typeComposer,
  inputTypeComposer,
}: {
  schemaComposer: SchemaComposer<TContext>;
  typeComposer:
    | ObjectTypeComposer<TSource, TContext>
    | InterfaceTypeComposer<TSource, TContext>;
  inputTypeComposer: InputTypeComposer<TContext>;
}): EnumTypeComposer<TContext> {
  const typeName = typeComposer.getTypeName();
  const fieldsEnumTypeName = `${typeName}FieldsEnum`;
  const fieldsEnumTypeComposer =
    schemaComposer.getOrCreateETC(fieldsEnumTypeName);
  addDerivedType({ typeComposer, derivedTypeName: fieldsEnumTypeName });

  const fields = convert({
    schemaComposer,
    typeComposer,
    fields: inputTypeComposer.getType().getFields(),
  });
  fieldsEnumTypeComposer.setFields(fields);
  return fieldsEnumTypeComposer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSortInput<TSource = any, TContext = any>({
  schemaComposer,
  typeComposer,
}: {
  schemaComposer: SchemaComposer<TContext>;
  typeComposer: ObjectTypeComposer<TSource, TContext>;
}): InputTypeComposer<TContext> {
  // toInputObjectType() will fail to convert fields of union types, e.g.
  //   union FooBar = Foo | Bar
  //   type Baz {
  //     fooBar: FooBar
  //   }
  // Passing `fallbackType: null` allows us to skip this field in the input type
  const inputTypeComposer = toInputObjectType(typeComposer, {
    fallbackType: null,
  });
  const sortOrderEnumTC = getSortOrderEnum({ schemaComposer });
  const fieldsEnumTC = getFieldsEnum({
    schemaComposer,
    typeComposer,
    inputTypeComposer,
  });
  const typeName = typeComposer.getTypeName();
  // console.log(fieldsEnumTC.getType().getValues())
  const sortInputTypeName = `${typeName}SortInput`;
  addDerivedType({ typeComposer, derivedTypeName: sortInputTypeName });

  return schemaComposer.getOrCreateITC(sortInputTypeName, (itc) => {
    itc.addFields({
      fields: [fieldsEnumTC],
      order: { type: [sortOrderEnumTC], defaultValue: ["ASC"] },
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Context = any;

export function getSortInputNestedObjects({
  schemaComposer,
  typeComposer,
}: {
  schemaComposer: SchemaComposer<Context>;
  typeComposer: ObjectTypeComposer<Context> | InterfaceTypeComposer<Context>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ListComposer<InputTypeComposer<any>> {
  const itc = convertToNestedInputType({
    schemaComposer,
    typeComposer,
    postfix: "SortInput",
    onEnter: ({ fieldName, typeComposer }): IVisitContext => {
      const sortable =
        typeComposer instanceof UnionTypeComposer ||
        typeComposer instanceof ScalarTypeComposer
          ? undefined
          : typeComposer.getFieldExtension(fieldName, "sortable");
      if (sortable === SORTABLE_ENUM.NOT_SORTABLE) {
        // stop traversing
        return null;
      } else if (sortable === SORTABLE_ENUM.DEPRECATED_SORTABLE) {
        // mark this and all nested fields as deprecated
        return {
          deprecationReason:
            "Sorting on fields that need arguments to resolve is deprecated.",
        };
      }

      // continue
      return undefined;
    },

    leafInputComposer: getSortOrderEnum({ schemaComposer }),
  });

  return itc.List;
}
