import React from 'react';
import { Bot, Sparkles, Brain, Cpu, User } from 'lucide-react';

interface ModelAvatarProps {
  provider?: string;
  model?: string;
  className?: string;
}

export function ModelAvatar({ provider, model, className = "w-8 h-8" }: ModelAvatarProps) {
  const getIcon = () => {
    switch (provider?.toLowerCase()) {
      case 'openai': return <Bot className="w-[60%] h-[60%]" />;
      case 'google': return <Sparkles className="w-[60%] h-[60%]" />;
      case 'anthropic': return <Brain className="w-[60%] h-[60%]" />;
      case 'xai': return <Cpu className="w-[60%] h-[60%]" />;
      default: return <User className="w-[60%] h-[60%]" />;
    }
  };

  const getBgColor = () => {
    switch (provider?.toLowerCase()) {
      case 'openai': return 'bg-emerald-500 shadow-emerald-500/20';
      case 'google': return 'bg-blue-500 shadow-blue-500/20';
      case 'anthropic': return 'bg-amber-600 shadow-amber-600/20';
      case 'xai': return 'bg-slate-700 shadow-slate-700/20';
      default: return 'bg-violet-500 shadow-violet-500/20';
    }
  };

  return (
    <div className={`${className} rounded-lg flex items-center justify-center text-white shadow-sm ring-2 ring-white/30 dark:ring-slate-800/30 ${getBgColor()}`}>
      {getIcon()}
    </div>
  );
}
