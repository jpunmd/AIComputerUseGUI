import { Cpu, Wifi, WifiOff, Activity } from 'lucide-react';

interface StatusBarProps {
  isConnected: boolean;
  isProcessing: boolean;
  apiEndpoint: string;
  modelId: string;
}

export function StatusBar({
  isConnected,
  isProcessing,
  apiEndpoint,
  modelId,
}: StatusBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-dark-900 border-t border-dark-700 text-xs">
      {/* Left side - Connection status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Wifi className="w-3.5 h-3.5 text-green-400" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-red-400" />
          )}
          <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        <div className="flex items-center gap-2 text-dark-400">
          <Cpu className="w-3.5 h-3.5" />
          <span className="truncate max-w-[200px]" title={modelId}>
            {modelId}
          </span>
        </div>
      </div>

      {/* Right side - API endpoint & processing status */}
      <div className="flex items-center gap-4">
        {isProcessing && (
          <div className="flex items-center gap-2 text-primary-400">
            <Activity className="w-3.5 h-3.5 animate-pulse" />
            <span>Processing...</span>
          </div>
        )}

        <span className="text-dark-500 truncate max-w-[300px]" title={apiEndpoint}>
          {apiEndpoint}
        </span>
      </div>
    </div>
  );
}
