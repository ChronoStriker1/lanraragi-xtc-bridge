export type ArchiveRecord = {
  arcid: string;
  title: string;
  filename: string;
  tags: string;
  summary: string;
  isnew: string | boolean;
  extension: string;
  progress: number;
  pagecount: number;
  lastreadtime: number;
  size: number;
};

export type SearchResponse = {
  recordsTotal: number;
  recordsFiltered: number;
  data: ArchiveRecord[];
};

export type ArchivePagesResponse = {
  pages: string[];
};

export type ConversionSettings = {
  orientation: "landscape" | "portrait";
  splitMode: "overlap" | "split" | "nosplit";
  noDither: boolean;
  overlap: boolean;
  splitSpreads: string;
  splitAll: boolean;
  skip: string;
  only: string;
  dontSplit: string;
  contrastBoost: string;
  margin: string;
  includeOverviews: boolean;
  sidewaysOverviews: boolean;
  selectOverviews: string;
  start: number | null;
  stop: number | null;
  padBlack: boolean;
  hsplitCount: number | null;
  hsplitOverlap: number | null;
  hsplitMaxWidth: number | null;
  vsplitTarget: number | null;
  vsplitMinOverlap: number | null;
  sampleSet: string;
};
