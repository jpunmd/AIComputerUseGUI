export interface Settings {
  apiEndpoint: string;
  modelId: string;
  displayWidth: number;
  displayHeight: number;
  systemPrompt: string;
  actionDelayMs: number; // Delay after action before next screenshot
  maxTurns: number; // Maximum number of turns before stopping
  screenshotMaxDimension: number; // Max width/height for screenshots sent to API
  enableThinking: boolean; // Enable thinking/reasoning mode for supported models
  expandThinkingByDefault: boolean; // Show thinking blocks expanded by default
  enablePlanning: boolean;
  zoomRefine: boolean; // Two-pass coarse-to-fine: re-click on a zoomed crop for precision
  zoomCropFraction: number; // Crop window size as a fraction of the screen (e.g. 0.3)
  boxRefine: boolean; // Model returns a bounding box of the target; we click its center. Applies to the final grounding pass (pass 2 when zoomRefine is on, pass 1 otherwise)
  debugMode: boolean; // Show developer instruments (the calibration probe in the expanded screenshot view)
  saveScreenshotsInSessions: boolean; // Include screenshots/zoom crops when saving sessions; off = text-only sessions (tiny storage)
  reviewEachAction: boolean; // Default for new runs: ask before each mouse/keyboard action (off = direct control)
  simpleToolFormat: boolean; // Flat tool call (screen/last_action/step_done) instead of the nested progress object; easier for small models
}

export interface Coordinate {
  x: number;
  y: number;
}

// Simple tool format: flat observations the controller turns into TaskProgress.
export interface StepReport {
  screen?: string;
  last_action?: 'worked' | 'failed' | 'unclear';
  step_done?: boolean;
}

export interface ActionResult {
  action: string;
  progress?: TaskProgress;
  report?: StepReport;
  arguments: {
    coordinate?: number[];
    text?: string;
    key?: string;
    start_coordinate?: number[];
    end_coordinate?: number[];
    direction?: string;
    amount?: number;
  };
}

export interface AgentResponse {
  format_warning?: string;
  output_text: string;
  action: ActionResult;
  coordinate_absolute?: Coordinate;
  success: boolean;
  error?: string;
  is_done?: boolean;
  thinking?: string;
}

export interface Message {
  modelResponse?: string; // Rejected model output for diagnosis only; never an action.
  task?: TaskRecord;
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  screenshot?: string;
  action?: ActionResult;
  stepNumber?: number; // For multi-turn, which step this is
  thinking?: string; // Reasoning content from thinking-enabled models
  zoomCrop?: string; // Base64 of the zoomed crop the refine pass looked at
  zoomCropCoordinate?: number[]; // Pass-2 click in 0-1000 over the crop image (for the crosshair)
  zoomCropBox?: number[]; // Pass-2 bounding box [x0,y0,x1,y1] in 0-1000 over the crop (box mode)
  screenshotBox?: number[]; // Pass-1 bounding box [x0,y0,x1,y1] in 0-1000 over the screenshot (box mode without zoom refine)
}

// Serializable version of Message for storage (Date as ISO string)
export interface SerializedMessage {
  modelResponse?: string;
  task?: TaskRecord;
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  screenshot?: string;
  action?: ActionResult;
  stepNumber?: number;
  thinking?: string;
  zoomCrop?: string;
  zoomCropCoordinate?: number[];
  zoomCropBox?: number[];
  screenshotBox?: number[];
}

// A saved chat session
export interface ChatSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: SerializedMessage[];
  initialQuery?: string;
}

// Screenshot with metadata from the backend
export interface ScreenshotWithMetadata {
  observation_id: string;
  base64_image: string;
  image_width: number;
  image_height: number;
  actual_screen_width: number;
  actual_screen_height: number;
}

export interface AppState {
  isConnected: boolean;
  isProcessing: boolean;
  currentScreenshot: string | null;
  messages: Message[];
  settings: Settings;
}

export interface TaskRecord {
  schemaVersion: 2;
  goal: string;
  plan: Milestone[];
  status: 'planning' | 'running' | 'stopped' | 'completed' | 'needs_user';
  summary: string;
  notes: MemoryNote[];
  receipts: ExecutionReceipt[];
  planChanges: { revision: number; reason: string; step: number }[];
  revision: number;
  lastStep: number;
  omittedNotes: number;
}

export type MilestoneStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked';
export interface Evidence {
  text: string;
  step: number;
  observationId: string;
  source: 'model_observation' | 'controller' | 'legacy';
}
export interface Milestone {
  id: string;
  title: string;
  successCriteria: string;
  status: MilestoneStatus;
  attempts: number;
  evidence?: Evidence;
}
export type NoteKind = 'fact' | 'artifact' | 'failure' | 'question';
export interface MemoryNote {
  id: string;
  kind: NoteKind;
  text: string;
  evidence: Evidence;
}
export interface ExecutionReceipt {
  step: number;
  observationId: string;
  milestoneId?: string;
  action: string;
  expected: string;
  outcome: 'unverified' | 'succeeded' | 'failed' | 'uncertain';
  evidence?: Evidence;
}

// Untrusted model metadata. It never contains executor authorization.
export interface TaskProgress {
  milestones?: {
    id: string;
    status: Exclude<MilestoneStatus, 'pending'>;
    evidence: string;
  }[];
  outcome?: {
    status: 'succeeded' | 'failed' | 'uncertain';
    evidence: string;
  };
  notes?: {
    id?: string;
    kind: NoteKind;
    text: string;
    evidence?: string;
  }[];
  resolve_questions?: { id: string; answer: string; evidence: string }[];
  next_milestone_id?: string;
  expected_outcome?: string;
}
