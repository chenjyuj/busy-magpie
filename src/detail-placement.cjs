'use strict';
// Where the request detail window sits relative to the card: beside it on the
// right when the card's own work area has room, flipped to the left when it
// does not, and clamped inside the work area either way. Pure arithmetic, so
// the main process only has to hand it two rectangles.
function placeDetail(size, card, area, gap = 12) {
  const width = Number(size && size.width) || 0;
  const height = Number(size && size.height) || 0;
  const cardX = Number(card && card.x) || 0;
  const cardY = Number(card && card.y) || 0;
  const cardWidth = Number(card && card.width) || 0;
  const areaX = Number(area && area.x) || 0;
  const areaY = Number(area && area.y) || 0;
  const areaWidth = Number(area && area.width) || 0;
  const areaHeight = Number(area && area.height) || 0;
  const step = Number.isFinite(Number(gap)) ? Number(gap) : 12;

  let x = cardX + cardWidth + step;
  if (x + width > areaX + areaWidth) x = cardX - step - width;
  if (x < areaX) x = areaX;

  // Down the card's top edge, lifted when the window would hang off the bottom.
  let y = cardY;
  const lowest = areaY + areaHeight - height;
  if (y > lowest) y = lowest;
  if (y < areaY) y = areaY;

  return {x: Math.round(x), y: Math.round(y)};
}

module.exports = {placeDetail};
