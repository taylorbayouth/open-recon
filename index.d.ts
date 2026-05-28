export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** [x, y, width, height] rounded to integers — used in tree and lean modes. */
export type BBoxArray = [number, number, number, number];

export interface ComputedStyle {
  cursor: string | null;
  display: string | null;
  visibility: string | null;
  opacity: string | null;
  'pointer-events': string | null;
  position: string | null;
  'z-index': string | null;
  'background-color': string | null;
  color: string | null;
  'font-size': string | null;
  'font-weight': string | null;
  'border-radius': string | null;
  overflow: string | null;
}

// ─── Full / lean mode ────────────────────────────────────────────────────────

/**
 * Stable reference assigned at extract time. Format: `@<type><n>` where
 * `<type>` is `e` (interactive element) or `t` (text node). Stable within a
 * single snapshot only — a new extraction reassigns. Regex: `/^@[et]\d+$/`.
 */
export type ElementRef = string;

/** Maps each `ref` to its CDP `backendNodeId` for the current session. */
export type RefLookup = Record<ElementRef, number>;

export interface FullElement {
  ref: ElementRef;
  role: string | null;
  name: string | null;
  source: 'role' | 'focusable';
  focusable: boolean | null;
  expanded: boolean | null;
  checked: boolean | 'mixed' | null;
  selected: boolean | null;
  disabled: boolean | null;
  url: string | null;
  bbox: BBox | null;
  inViewport: boolean;
  computedStyle: ComputedStyle | null;
}

export interface LeanElement {
  ref: ElementRef;
  role: string | null;
  name: string | null;
  bbox: BBox | null;
  inViewport: boolean;
  value?: string;
  url?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: true;
}

export interface TextNode {
  ref: ElementRef;
  role: string | null;
  name: string;
  level: number | null;
  bbox: BBox | null;
  inViewport: boolean;
}

export interface FlatStats {
  totalAXNodes: number;
  interactiveFound: number;
  textFound: number;
  withBounds: number;
  inViewport: number;
  returned: number;
  elapsedMs: number;
}

export interface FlatResult {
  schemaVersion: '2.0';
  url: string;
  title: string;
  timestamp: string;
  viewport: Viewport;
  elements: FullElement[] | LeanElement[];
  text: TextNode[];
  lookup: RefLookup;
  stats: FlatStats;
}

// ─── Tree mode ───────────────────────────────────────────────────────────────

export interface TreeInteractiveNode {
  ref: ElementRef;
  role: string;
  name?: string;
  bbox: BBoxArray;
  inViewport?: true;
  value?: string;
  url?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: true;
}

export interface TreeTextNode {
  ref: ElementRef;
  role: string;
  name: string;
  bbox?: BBoxArray;
  inViewport?: true;
  level?: number;
}

export interface TreeContainerNode {
  role: string;
  name?: string;
  children: TreeNode[];
}

export type TreeNode = TreeInteractiveNode | TreeTextNode | TreeContainerNode;

export interface TreeStats {
  totalAXNodes: number;
  interactiveReturned: number;
  textReturned: number;
  elapsedMs: number;
}

export interface TreeResult {
  schemaVersion: '2.0';
  url: string;
  title: string;
  timestamp: string;
  viewport: Viewport;
  tree: TreeContainerNode | null;
  lookup: RefLookup;
  stats: TreeStats;
}

export type ExtractionResult = FlatResult | TreeResult;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** CDP debugging port. Default: 9222 */
  port?: number;
  /** Output format. Default: 'full' */
  format?: 'tree' | 'lean' | 'full';
  /** Only return elements whose bbox intersects the current viewport. Default: false */
  inViewportOnly?: boolean;
  /** Auto-launch Chrome if not already running. Default: false */
  launch?: boolean;
  /** Substring to match against tab URLs when selecting which tab to use. */
  url?: string;
  /** Override default interactive role set. */
  interactiveRoles?: string[];
  /** Override default container role set (tree mode only). */
  containerRoles?: string[];
  /** Print progress to stderr. Default: false */
  verbose?: boolean;
}

export interface LaunchOptions {
  /** CDP debugging port. Default: 9222 */
  port?: number;
  /** Explicit path to Chrome/Chromium executable. */
  executablePath?: string;
  /** Chrome user data directory. Default: ~/.chrome-agent */
  userDataDir?: string;
  /** Launch Chrome in headless mode. Default: false */
  headless?: boolean;
  /** Maximum ms to wait for Chrome to become ready. Default: 10000 */
  timeout?: number;
  /** Additional Chrome CLI flags. */
  extraArgs?: string[];
}

// ─── Session ─────────────────────────────────────────────────────────────────

export declare class Session {
  /** Raw CDP client for direct protocol access. */
  readonly client: object;
  extract(opts?: ExtractOptions): Promise<ExtractionResult>;
  close(): Promise<void>;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/** Open a persistent CDP session. Reuse for multiple extract() calls. */
export declare function connect(opts?: ExtractOptions & LaunchOptions): Promise<Session>;

/** One-shot: connect, extract, disconnect. */
export declare function extract(opts?: ExtractOptions & LaunchOptions): Promise<ExtractionResult>;

/** Launch Chrome with remote debugging enabled. No-op if already running. */
export declare function launch(opts?: LaunchOptions): Promise<void>;

/** Check if Chrome is already listening on the given port. */
export declare function isRunning(port?: number): Promise<boolean>;
