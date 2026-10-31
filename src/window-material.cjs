'use strict';

// The card is a light, opaque sheet that draws its own rounded corners and
// shadow, so the window never asks for a platform material. The transparent
// window stays only so the 16px margin around the card and its rounded
// corners composite cleanly over the desktop.
function windowMaterial() {
  return { kind: 'none', options: { transparent: true, roundedCorners: false, hasShadow: false } };
}

module.exports = { windowMaterial };
