interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CASCADE_OFFSET_PX = 28;

/** Places a new window down and right of the window it opened from, wrapping inside that display. */
export function cascadeWindowBounds(input: {
  readonly anchor: Rectangle | null;
  readonly size: { readonly width: number; readonly height: number };
  readonly displays: readonly Rectangle[];
}): Rectangle | { readonly width: number; readonly height: number } {
  const { anchor } = input;
  if (anchor === null) return input.size;
  const display =
    input.displays.find(
      (candidate) =>
        anchor.x >= candidate.x &&
        anchor.y >= candidate.y &&
        anchor.x < candidate.x + candidate.width &&
        anchor.y < candidate.y + candidate.height,
    ) ?? input.displays[0];
  if (display === undefined) return input.size;
  const width = Math.min(input.size.width, display.width);
  const height = Math.min(input.size.height, display.height);
  let x = anchor.x + CASCADE_OFFSET_PX;
  let y = anchor.y + CASCADE_OFFSET_PX;
  if (x + width > display.x + display.width || y + height > display.y + display.height) {
    x = display.x + CASCADE_OFFSET_PX;
    y = display.y + CASCADE_OFFSET_PX;
  }
  return {
    x: Math.round(Math.min(x, display.x + display.width - width)),
    y: Math.round(Math.min(y, display.y + display.height - height)),
    width,
    height,
  };
}
