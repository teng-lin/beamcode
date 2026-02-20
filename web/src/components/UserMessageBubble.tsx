interface UserMessageBubbleProps {
  content: string;
}

export function UserMessageBubble({ content }: UserMessageBubbleProps) {
  return (
    <div className="self-end rounded-2xl bg-bc-user-bg px-4 py-2.5 text-sm max-w-[85%] border border-bc-border/30">
      {content}
    </div>
  );
}
