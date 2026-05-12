/**
 * Label rendering style for bounding box index annotations.
 *
 * - "legacy"   : Solid colored background with white text, fixed top-right position.
 * - "noocclude": No background, bold colored text with outline/shadow,
 *                smart-positioned in the least busy area of the bounding box.
 */
export type LabelStyle = "legacy" | "noocclude";

let _labelStyle: LabelStyle = "legacy";

export function setLabelStyle(style: LabelStyle): void {
  _labelStyle = style;
}

export function getLabelStyle(): LabelStyle {
  return _labelStyle;
}
