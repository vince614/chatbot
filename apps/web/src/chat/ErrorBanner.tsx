interface ErrorBannerProps {
  message: string;
  /** Absent : réessayer ne changerait rien (requête refusée), pas de bouton. */
  onRetry?: () => void;
}

export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="error-banner__retry" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}
