export type ArchiveRecord = {
  arcid: string;
  title: string;
  filename: string;
  tags: string;
  summary: string;
  extension: string;
  pagecount: number;
  size: number;
  progress: number;
  lastreadtime: number;
};

export type SearchResponse = {
  recordsTotal: number;
  recordsFiltered: number;
  data: ArchiveRecord[];
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

export type ConversionJobPage = {
  label: string;
  done: boolean;
};

export type ConversionJob = {
  jobId: string;
  archiveId: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  message: string;
  progress: number;
  totalPages: number;
  completedPages: number;
  pages: ConversionJobPage[];
  currentPagePath: string | null;
  currentConvertedFrameLabel: string | null;
  convertedFrameVersion: number;
  error: string | null;
  downloadName: string | null;
  fileSize: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceFileEntry = {
  name: string;
  size: number;
  isDirectory: boolean;
  isEpub: boolean;
};
