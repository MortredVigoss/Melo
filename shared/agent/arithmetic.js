const UNIT_TABLE = {
  // length (base: m)
  km: { base: 'm', factor: 1000 }, m: { base: 'm', factor: 1 },
  cm: { base: 'm', factor: 0.01 }, mm: { base: 'm', factor: 0.001 },
  mi: { base: 'm', factor: 1609.344 }, mile: { base: 'm', factor: 1609.344 },
  ft: { base: 'm', factor: 0.3048 }, inch: { base: 'm', factor: 0.0254 },
  in: { base: 'm', factor: 0.0254 }, yard: { base: 'm', factor: 0.9144 },
  // weight (base: kg)
  kg: { base: 'kg', factor: 1 }, g: { base: 'kg', factor: 0.001 },
  mg: { base: 'kg', factor: 0.000001 }, lb: { base: 'kg', factor: 0.453592 },
  oz: { base: 'kg', factor: 0.0283495 }, ton: { base: 'kg', factor: 1000 },
  // temperature handled separately
  // time (base: s)
  s: { base: 's', factor: 1 }, sec: { base: 's', factor: 1 },
  min: { base: 's', factor: 60 }, h: { base: 's', factor: 3600 },
  hr: { base: 's', factor: 3600 }, hour: { base: 's', factor: 3600 },
  day: { base: 's', factor: 86400 }, week: { base: 's', factor: 604800 },
  // data (base: byte)
  byte: { base: 'byte', factor: 1 }, kb: { base: 'byte', factor: 1024 },
  mb: { base: 'byte', factor: 1048576 }, gb: { base: 'byte', factor: 1073741824 },
  tb: { base: 'byte', factor: 1099511627776 },
};

export function convertUnit(value, from, to) {
  const fl = from.toLowerCase();
  const tl = to.toLowerCase();

  // Temperature special case
  const tempNames = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };
  if (Object.hasOwn(tempNames,fl) && Object.hasOwn(tempNames,tl)) {
    const fc = tempNames[fl], tc = tempNames[tl];
    let celsius;
    if (fc === 'c') celsius = value;
    else if (fc === 'f') celsius = (value - 32) * 5 / 9;
    else celsius = value - 273.15;
    let result;
    if (tc === 'c') result = celsius;
    else if (tc === 'f') result = celsius * 9 / 5 + 32;
    else result = celsius + 273.15;
    return { result: +result.toFixed(6), from, to, value };
  }

  const fromU = UNIT_TABLE[fl], toU = UNIT_TABLE[tl];
  if (!Object.hasOwn(UNIT_TABLE,fl) || !Object.hasOwn(UNIT_TABLE,tl)) return { error: `Unknown unit: ${!fromU ? from : to}` };
  if (fromU.base !== toU.base) return { error: `Cannot convert ${from} (${fromU.base}) to ${to} (${toU.base})` };
  const result = value * fromU.factor / toU.factor;
  return { result: +result.toFixed(6), from, to, value };
}

// Restricted numeric grammar. A calculation can never resolve global names,
// access properties or construct executable code.
const mathFunctions = { abs:Math.abs, ceil:Math.ceil, floor:Math.floor, round:Math.round, sqrt:Math.sqrt, cbrt:Math.cbrt, pow:Math.pow,
  log:Math.log, log2:Math.log2, log10:Math.log10, sin:Math.sin, cos:Math.cos, tan:Math.tan, min:Math.min, max:Math.max, random:Math.random };
const precedence = { '+':1, '-':1, '*':2, '/':2, '%':2, '^':3, '**':3 };
export function safeMathEval(expression) {
  if (typeof expression !== 'string' || expression.length > 1024) throw new Error('Invalid expression length');
  const tokens = expression.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Z_][A-Z_0-9]*|\*\*|[^\s]/gi) || [];
  if (tokens.length > 256) throw new Error('Expression is too complex');
  let cursor = 0;
  function take(token) { if (tokens[cursor] !== token) throw new Error('Expected '+token); cursor++; }
  function parse(minimum) {
    const token = tokens[cursor++];
    let value;
    if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * parse(3);
    else if (token === '(') { value = parse(0); take(')'); }
    else if (token === 'PI' || token === 'E') value = Math[token];
    else if (Object.hasOwn(mathFunctions, token)) {
      take('(');
      const args = [];
      if (tokens[cursor] !== ')') {
        args.push(parse(0));
        while (tokens[cursor] === ',') { cursor++; args.push(parse(0)); }
      }
      take(')'); value = mathFunctions[token](...args);
    } else if (token && /^[.\d]/.test(token)) value = Number(token);
    else throw new Error('Expected a number or a supported math function');
    while (Object.hasOwn(precedence,tokens[cursor]) && precedence[tokens[cursor]] >= minimum) {
      const op = tokens[cursor++], rank = precedence[op], right = parse(rank === 3 ? rank : rank+1);
      switch(op) {
        case '+': value += right; break; case '-': value -= right; break;
        case '*': value *= right; break; case '/': value /= right; break;
        case '%': value %= right; break; default: value **= right;
      }
    }
    return value;
  }
  const result = parse(0);
  if (cursor !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid or nonfinite result');
  return result;
}
export const PHONE_CALCULATOR = { name:'calculator', description:'Calculate a numeric expression or convert units, e.g. 20 celsius to fahrenheit.', parameters:{
  type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['math','convert']}, expression:{type:'string',maxLength:1024},value:{type:'number'},from:{type:'string',maxLength:32},to:{type:'string',maxLength:32}},required:['action']
} };
export function calculateNumber(args) {
  if (args?.action === 'math') return {expression:args.expression, result:safeMathEval(args.expression)};
  if (args?.action !== 'convert' || !Number.isFinite(args.value) || typeof args.from !== 'string' || typeof args.to !== 'string') throw new Error('Invalid calculation arguments');
  const value = convertUnit(args.value,args.from,args.to);
  if (!Number.isFinite(value.result)) throw new Error(value.error || 'Invalid conversion');
  return value;
}
