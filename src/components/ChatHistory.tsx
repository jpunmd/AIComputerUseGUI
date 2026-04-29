import { useEffect, useRef, useState } from 'react';
import { Message } from '../types';
import { Bot, User, MousePointer, Keyboard, Move, Info, CheckCircle, AlertCircle, StopCircle, X, ZoomIn, ChevronRight, Brain } from 'lucide-react';

interface ChatHistoryProps {
  messages: Message[];
}

export function ChatHistory({ messages }: ChatHistoryProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});

  const toggleThinking = (id: string) => {
    setExpandedThinking(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-dark-500">
        <div className="text-center">
          <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No messages yet</p>
          <p className="text-sm mt-1">Enter a command to get started</p>
        </div>
      </div>
    );
  }

  const getActionIcon = (action?: Message['action']) => {
    if (!action) return null;
    
    switch (action.action) {
      case 'click':
      case 'left_click':
      case 'right_click':
      case 'double_click':
        return <MousePointer className="w-4 h-4" />;
      case 'type':
      case 'key':
        return <Keyboard className="w-4 h-4" />;
      case 'scroll':
      case 'drag':
        return <Move className="w-4 h-4" />;
      default:
        return null;
    }
  };

  const formatAction = (action?: Message['action']) => {
    if (!action) return null;

    let description = action.action || 'action';
    if (action.arguments?.coordinate) {
      description += ` at (${Math.round(action.arguments.coordinate[0])}, ${Math.round(action.arguments.coordinate[1])})`;
    }
    if (action.arguments?.text) {
      description += `: "${action.arguments.text}"`;
    }
    if (action.arguments?.key) {
      description += `: ${action.arguments.key}`;
    }

    return description;
  };

  // Clean up the content - remove tool_call XML tags but keep thinking
  const cleanContent = (content: string) => {
    // Extract text before <tool_call> as the model's thinking
    const toolCallIndex = content.indexOf('<tool_call>');
    let thinking = '';
    
    if (toolCallIndex > 0) {
      thinking = content.substring(0, toolCallIndex).trim();
    }
    
    // Remove <tool_call>...</tool_call> blocks
    let cleaned = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    
    // If we have thinking, use that
    if (thinking) {
      return thinking;
    }
    
    // If nothing left after cleaning, show a friendly message
    if (!cleaned) {
      return 'Action detected';
    }
    return cleaned;
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''} ${message.role === 'system' ? 'justify-center' : ''}`}
        >
          {/* System message styling */}
          {message.role === 'system' ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-dark-800/50 border border-dark-700 rounded-full text-sm">
              {message.content.startsWith('✓') ? (
                <CheckCircle className="w-4 h-4 text-green-400" />
              ) : message.content.startsWith('⚠') ? (
                <AlertCircle className="w-4 h-4 text-yellow-400" />
              ) : message.content.startsWith('⏹') ? (
                <StopCircle className="w-4 h-4 text-red-400" />
              ) : (
                <Info className="w-4 h-4 text-dark-400" />
              )}
              <span className="text-dark-300">{message.content}</span>
            </div>
          ) : (
            <>
              {/* Avatar */}
              <div
                className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                  message.role === 'user'
                    ? 'bg-primary-500/20'
                    : 'bg-dark-700'
                }`}
              >
                {message.role === 'user' ? (
                  <User className="w-4 h-4 text-primary-400" />
                ) : (
                  <Bot className="w-4 h-4 text-dark-300" />
                )}
              </div>

              {/* Message content */}
              <div
                className={`max-w-[80%] flex flex-col ${
                  message.role === 'user' ? 'items-end text-right' : 'items-start'
                }`}
              >
                {/* Step number badge for multi-turn */}
                {message.stepNumber && (
                  <div className="mb-1">
                    <span className="text-xs px-2 py-0.5 bg-primary-500/20 text-primary-400 rounded-full">
                      Step {message.stepNumber}
                    </span>
                  </div>
                )}

                {/* Thinking block - collapsible, shown before action */}
                {message.role === 'assistant' && message.thinking && (
                  <div className="mb-2 w-full max-w-full">
                    <button
                      onClick={() => toggleThinking(message.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-dark-800/50 hover:bg-dark-800 border border-dark-700 rounded-lg text-xs text-dark-300 hover:text-dark-100 transition-colors"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 transition-transform ${expandedThinking[message.id] ? 'rotate-90' : ''}`}
                      />
                      <Brain className="w-3.5 h-3.5 text-primary-400" />
                      <span>Thinking</span>
                    </button>
                    {expandedThinking[message.id] && (
                      <div className="mt-1.5 px-3 py-2 bg-dark-900/70 border border-dark-700 rounded-lg text-xs text-dark-300 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                        {message.thinking}
                      </div>
                    )}
                  </div>
                )}

                <div
                  className={`inline-block px-4 py-2 rounded-2xl ${
                    message.role === 'user'
                      ? 'bg-primary-500 text-white rounded-tr-sm'
                      : 'bg-dark-800 text-dark-100 rounded-tl-sm'
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{message.role === 'assistant' ? cleanContent(message.content) : message.content}</p>
                </div>

                {/* Action badge */}
                {message.action && (
                  <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-xs text-dark-300">
                    {getActionIcon(message.action)}
                    <span>{formatAction(message.action)}</span>
                  </div>
                )}

                {/* Screenshot thumbnail */}
                {message.screenshot && (
                  <div className="mt-2 group relative inline-block">
                    <img
                      src={`data:image/png;base64,${message.screenshot}`}
                      alt="Screenshot"
                      onClick={() => setExpandedScreenshot(message.screenshot!)}
                      className="max-w-[200px] rounded-lg border border-dark-600 opacity-75 hover:opacity-100 transition-opacity cursor-pointer"
                    />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                      <div className="bg-black/50 p-2 rounded-full backdrop-blur-sm">
                        <ZoomIn className="w-5 h-5 text-white" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Timestamp */}
                <p className="text-xs text-dark-600 mt-1">
                  {message.timestamp.toLocaleTimeString()}
                </p>
              </div>
            </>
          )}
        </div>
      ))}
      {/* Scroll anchor */}
      <div ref={messagesEndRef} />

      {/* Expanded Screenshot Modal */}
      {expandedScreenshot && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-8"
          onClick={() => setExpandedScreenshot(null)}
        >
          <div className="relative max-w-full max-h-full">
            <button
              onClick={() => setExpandedScreenshot(null)}
              className="absolute -top-12 right-0 p-2 text-white/70 hover:text-white transition-colors"
            >
              <X className="w-8 h-8" />
            </button>
            <img
              src={`data:image/png;base64,${expandedScreenshot}`}
              alt="Expanded Screenshot"
              className="max-w-full max-h-[90vh] rounded-lg shadow-2xl border border-dark-700"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
