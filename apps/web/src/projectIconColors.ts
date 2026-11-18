import type { ProjectIconColor } from "@t3tools/contracts";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  readonly swatchClassName: string;
  /** The swatch class's colour as a CSS value, for code that computes with it. */
  readonly swatch: string;
}> = [
  {
    value: "gray",
    label: "Gray",
    className: "text-gray-600 dark:text-gray-400",
    swatchClassName: "bg-gray-500",
    swatch: "oklch(55.1% 0.027 264.364)",
  },
  {
    value: "red",
    label: "Red",
    className: "text-red-600 dark:text-red-400",
    swatchClassName: "bg-red-500",
    swatch: "oklch(63.7% 0.237 25.331)",
  },
  {
    value: "orange",
    label: "Orange",
    className: "text-orange-600 dark:text-orange-400",
    swatchClassName: "bg-orange-500",
    swatch: "oklch(70.5% 0.213 47.604)",
  },
  {
    value: "amber",
    label: "Amber",
    className: "text-amber-600 dark:text-amber-400",
    swatchClassName: "bg-amber-500",
    swatch: "oklch(76.9% 0.188 70.08)",
  },
  {
    value: "yellow",
    label: "Yellow",
    className: "text-yellow-600 dark:text-yellow-400",
    swatchClassName: "bg-yellow-500",
    swatch: "oklch(79.5% 0.184 86.047)",
  },
  {
    value: "lime",
    label: "Lime",
    className: "text-lime-600 dark:text-lime-400",
    swatchClassName: "bg-lime-500",
    swatch: "oklch(76.8% 0.233 130.85)",
  },
  {
    value: "green",
    label: "Green",
    className: "text-green-600 dark:text-green-400",
    swatchClassName: "bg-green-500",
    swatch: "oklch(72.3% 0.219 149.579)",
  },
  {
    value: "emerald",
    label: "Emerald",
    className: "text-emerald-600 dark:text-emerald-400",
    swatchClassName: "bg-emerald-500",
    swatch: "oklch(69.6% 0.17 162.48)",
  },
  {
    value: "teal",
    label: "Teal",
    className: "text-teal-600 dark:text-teal-400",
    swatchClassName: "bg-teal-500",
    swatch: "oklch(70.4% 0.14 182.503)",
  },
  {
    value: "cyan",
    label: "Cyan",
    className: "text-cyan-600 dark:text-cyan-400",
    swatchClassName: "bg-cyan-500",
    swatch: "oklch(71.5% 0.143 215.221)",
  },
  {
    value: "sky",
    label: "Sky",
    className: "text-sky-600 dark:text-sky-400",
    swatchClassName: "bg-sky-500",
    swatch: "oklch(68.5% 0.169 237.323)",
  },
  {
    value: "blue",
    label: "Blue",
    className: "text-blue-600 dark:text-blue-400",
    swatchClassName: "bg-blue-500",
    swatch: "oklch(62.3% 0.214 259.815)",
  },
  {
    value: "indigo",
    label: "Indigo",
    className: "text-indigo-600 dark:text-indigo-400",
    swatchClassName: "bg-indigo-500",
    swatch: "oklch(58.5% 0.233 277.117)",
  },
  {
    value: "violet",
    label: "Violet",
    className: "text-violet-600 dark:text-violet-400",
    swatchClassName: "bg-violet-500",
    swatch: "oklch(60.6% 0.25 292.717)",
  },
  {
    value: "purple",
    label: "Purple",
    className: "text-purple-600 dark:text-purple-400",
    swatchClassName: "bg-purple-500",
    swatch: "oklch(62.7% 0.265 303.9)",
  },
  {
    value: "fuchsia",
    label: "Fuchsia",
    className: "text-fuchsia-600 dark:text-fuchsia-400",
    swatchClassName: "bg-fuchsia-500",
    swatch: "oklch(66.7% 0.295 322.15)",
  },
  {
    value: "pink",
    label: "Pink",
    className: "text-pink-600 dark:text-pink-400",
    swatchClassName: "bg-pink-500",
    swatch: "oklch(65.6% 0.241 354.308)",
  },
  {
    value: "rose",
    label: "Rose",
    className: "text-rose-600 dark:text-rose-400",
    swatchClassName: "bg-rose-500",
    swatch: "oklch(64.5% 0.246 16.439)",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}

const PROJECT_ICON_SWATCHES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, swatch }) => [value, swatch]),
) as Record<ProjectIconColor, string>;

export function projectIconSwatch(color: ProjectIconColor): string {
  return PROJECT_ICON_SWATCHES[color];
}
