export interface Settings {
  apiEndpoint: string;
  modelId: string;
  displayWidth: number;
  displayHeight: number;
  maxTokens: number;
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
  };
}

export interface AgentResponse {
  output_text: string;
  action: ActionResult;
  coordinate_absolute?: Coordinate;
  success: boolean;
  error?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  screenshot?: string;
  action?: ActionResult;
}

export interface AppState {
  isConnected: boolean;
  isProcessing: boolean;
  currentScreenshot: string | null;
  messages: Message[];
  settings: Settings;
}
