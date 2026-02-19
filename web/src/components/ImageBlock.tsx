interface ImageBlockProps {
  media_type: string;
  data: string;
}

export function ImageBlock({ media_type, data }: ImageBlockProps) {
  return (
    <div className="rounded-lg border border-bc-border/40 overflow-hidden">
      <img
        src={`data:${media_type};base64,${data}`}
        alt="Generated content"
        className="max-w-full block"
      />
    </div>
  );
}
