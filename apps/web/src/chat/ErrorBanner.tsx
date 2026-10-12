interface ErrorBannerProps {
  message: string;
  onRetry: () => void;
}

export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button type="button" className="error-banner__retry" onClick={onRetry}>
        Réessayer
      </button>
    </div>
  );
}
