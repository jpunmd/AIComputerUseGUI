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
  autoApproveConfirmations: boolean; // Skip confirmation prompts for sensitive actions
  zoomRefine: boolean; // Two-pass coarse-to-fine: re-click on a zoomed crop for precision
  zoomCropFraction: number; // Crop window size as a fraction of the screen (e.g. 0.3)
  boxRefine: boolean; // Model returns a bounding box of the target; we click its center. Applies to the final grounding pass (pass 2 when zoomRefine is on, pass 1 otherwise)
  debugMode: boolean; // Show developer instruments (the calibration probe in the expanded screenshot view)
  saveScreenshotsInSessions: boolean; // Include screenshots/zoom crops when saving sessions; off = text-only sessions (tiny storage)
}

export interface Coordinate {
  x: number;
  y: number;
}

export interface ActionResult {
  action: string;
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
  output_text: string;
  action: ActionResult;
  coordinate_absolute?: Coordinate;
  success: boolean;
  error?: string;
  is_done?: boolean;
  thinking?: string;
}

export interface Message {
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
