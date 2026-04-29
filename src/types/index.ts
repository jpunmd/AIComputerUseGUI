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
