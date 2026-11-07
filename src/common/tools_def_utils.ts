// =====================================================================
//  tools_def_utils.ts —— 工具描述 prompt 合并器
//
//  prompt.ts 只放纯文案 table，具体的 tool 在 tools_of_*.ts 里定义。
//  这里把二者水合，变成 DSH 工具注册所需的最终 JSON Schema，
//  并校验两侧参数名一致（不一致直接报错）。
// =====================================================================

// 参数结构定义：type 是 JSON Schema 类型，required 标记必填。
export interface ParamDef {
  type: 'string' | 'integer' | 'boolean';
  required?: boolean;
}

// 描述 table：参数名 → 一句话描述。
export type ParamDescriptions = Record<string, string>;

// 工具提示词：description + 参数描述 table（不含类型，纯文案）。
export interface ToolPrompt {
  description: string;
  parameters: ParamDescriptions;
}

// 把描述 table 与结构定义水合成 JSON Schema 的 parameters 部分。
// 两侧参数名必须一致，否则抛错。
export function hydrateParameters(
  descriptions: ParamDescriptions,
  defs: Record<string, ParamDef>,
): Record<string, unknown> {
  const descKeys = new Set(Object.keys(descriptions));
  const defKeys = Object.keys(defs);
  const missingDesc = defKeys.filter((k) => !descKeys.has(k));
  const extraDesc = [...descKeys].filter((k) => !(k in defs));
  if (missingDesc.length || extraDesc.length) {
    throw new Error(
      `参数名不一致：结构有而描述缺 [${missingDesc.join(', ')}]，描述有而结构缺 [${extraDesc.join(', ')}]`,
    );
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    properties[name] = { type: def.type, description: descriptions[name] };
    if (def.required) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
