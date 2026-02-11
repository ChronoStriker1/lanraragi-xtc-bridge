import type { ConversionSettings } from "../types";

export const defaultConversionSettings: ConversionSettings = {
  orientation: "landscape",
  splitMode: "overlap",
  noDither: false,
  overlap: true,
  splitSpreads: "",
  splitAll: false,
  skip: "",
  only: "",
  dontSplit: "",
  contrastBoost: "4",
  margin: "0",
  includeOverviews: false,
  sidewaysOverviews: false,
  selectOverviews: "",
  start: null,
  stop: null,
  padBlack: false,
  hsplitCount: null,
  hsplitOverlap: null,
  hsplitMaxWidth: null,
  vsplitTarget: null,
  vsplitMinOverlap: null,
  sampleSet: "",
};

function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function settingsToCbz2xtcArgs(settings: ConversionSettings): string[] {
  const args: string[] = [];

  const effectiveOverlap = settings.splitMode === "overlap" || settings.overlap;

  if (effectiveOverlap) args.push("--overlap");
  if (settings.noDither) args.push("--no-dither");
  if (settings.splitAll) args.push("--split-all");
  if (settings.includeOverviews) args.push("--include-overviews");
  if (settings.sidewaysOverviews) args.push("--sideways-overviews");
  if (settings.padBlack) args.push("--pad-black");

  if (hasValue(settings.splitSpreads)) args.push("--split-spreads", settings.splitSpreads.trim());
  if (hasValue(settings.skip)) args.push("--skip", settings.skip.trim());
  if (hasValue(settings.only)) args.push("--only", settings.only.trim());
  if (hasValue(settings.dontSplit)) args.push("--dont-split", settings.dontSplit.trim());
  if (hasValue(settings.contrastBoost)) args.push("--contrast-boost", settings.contrastBoost.trim());
  if (hasValue(settings.margin)) args.push("--margin", settings.margin.trim());
  if (hasValue(settings.selectOverviews)) args.push("--select-overviews", settings.selectOverviews.trim());
  if (hasValue(settings.sampleSet)) args.push("--sample-set", settings.sampleSet.trim());

  if (Number.isInteger(settings.start) && settings.start !== null && settings.start > 0) {
    args.push("--start", String(settings.start));
  }
  if (Number.isInteger(settings.stop) && settings.stop !== null && settings.stop > 0) {
    args.push("--stop", String(settings.stop));
  }
  if (Number.isInteger(settings.hsplitCount) && settings.hsplitCount !== null && settings.hsplitCount > 0) {
    args.push("--hsplit-count", String(settings.hsplitCount));
  }
  if (typeof settings.hsplitOverlap === "number" && Number.isFinite(settings.hsplitOverlap) && settings.hsplitOverlap > 0) {
    args.push("--hsplit-overlap", String(settings.hsplitOverlap));
  }
  if (Number.isInteger(settings.hsplitMaxWidth) && settings.hsplitMaxWidth !== null && settings.hsplitMaxWidth > 0) {
    args.push("--hsplit-max-width", String(settings.hsplitMaxWidth));
  }
  if (Number.isInteger(settings.vsplitTarget) && settings.vsplitTarget !== null && settings.vsplitTarget > 0) {
    args.push("--vsplit-target", String(settings.vsplitTarget));
  }
  if (typeof settings.vsplitMinOverlap === "number" && Number.isFinite(settings.vsplitMinOverlap) && settings.vsplitMinOverlap >= 0) {
    args.push("--vsplit-min-overlap", String(settings.vsplitMinOverlap));
  }

  args.push("--clean");
  return args;
}
