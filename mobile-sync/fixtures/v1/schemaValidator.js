// Deliberately small JSON Schema subset used by the checked-in wire contract.
// Generation rejects unsupported keywords so schema changes cannot be ignored.
export function validateSchema(value, schema, root = schema) {
  const fail = () => { throw new Error('Invalid workspace sync schema'); };
  if (schema.$ref) return validateSchema(value,root.$defs[schema.$ref.split('/').at(-1)],root);
  if (Object.hasOwn(schema,'const') && JSON.stringify(value)!==JSON.stringify(schema.const)) fail();
  if (schema.enum && !schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value))) fail();
  if (schema.not) { let matched=true;try{validateSchema(value,schema.not,root);}catch{matched=false;}if(matched)fail(); }
  if (schema.anyOf && !schema.anyOf.some(item=>{try{validateSchema(value,item,root);return true;}catch{return false;}}))fail();
  for(const item of schema.allOf||[])validateSchema(value,item,root);
  if(schema.if) {let matches=true;try{validateSchema(value,schema.if,root);}catch{matches=false;}if(matches&&schema.then)validateSchema(value,schema.then,root);}
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(schema.type && !types.includes(type) && !(types.includes('integer')&&typeof value==='number'&&Number.isSafeInteger(value)))fail();
  if(typeof value==='string') {
    if(schema.minLength!==undefined&&[...value].length<schema.minLength||schema.maxLength!==undefined&&[...value].length>schema.maxLength)fail();
    if(schema['x-minUtf16Length']!==undefined&&value.length<schema['x-minUtf16Length']||schema['x-maxUtf16Length']!==undefined&&value.length>schema['x-maxUtf16Length'])fail();
    if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail();
  }
  if(typeof value==='number' && (!Number.isFinite(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))fail();
  if(Array.isArray(value)) {
    if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)fail();
    if(schema.items)for(const item of value)validateSchema(item,schema.items,root);
  } else if(value&&typeof value==='object') {
    const keys=Object.keys(value);
    if(schema.minProperties!==undefined&&keys.length<schema.minProperties||schema.maxProperties!==undefined&&keys.length>schema.maxProperties)fail();
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))fail();
    for(const key of keys) {
      if(schema.propertyNames)validateSchema(key,schema.propertyNames,root);
      if(schema.properties?.[key])validateSchema(value[key],schema.properties[key],root);
      else if(schema.additionalProperties===false)fail();
      else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validateSchema(value[key],schema.additionalProperties,root);
    }
  }
  return value;
}
