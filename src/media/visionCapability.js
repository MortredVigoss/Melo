const VISION_PATTERNS = [
  /^gpt-4o/i,
  /^gpt-4-turbo/i,
  /^gpt-4-vision/i,
  /^gpt-4\.1/i,
  /^chatgpt-4o/i,
  /^gpt-5/i,
  /^o[134](?:$|-)/i,
  /^claude-3/i,
  /^claude-(?:sonnet|opus|haiku)-[34]/i,
  /^gemini-(1\.5|2|pro)/i,
  /^qwen.*vl/i,
  /^llava/i,
  /^pixtral/i,
  /^intern(?:vl|-vl)/i,
  /vision/i,
];

export function modelSupportsVision(modelName = '') {
  const normalized = String(modelName || '').trim();
  if (!normalized) {
    return false;
  }

  return VISION_PATTERNS.some(pattern => pattern.test(normalized));
}
