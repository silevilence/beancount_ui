/** 仅移除完整千位分组中的逗号；未完成或错误输入保留供继续编辑／校验。 */
export function normalizeAmount(value = ""): string {
  const trimmed = value.trim();
  return /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)
    ? trimmed.replaceAll(",", "")
    : trimmed;
}
