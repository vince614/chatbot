import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { MessageList } from "./MessageList";
import { useChat } from "./useChat";
import "./chat.css";

export function Chat() {
  const { messages, status, error, send, stop, retry } = useChat();

  return (
    <div className="chat">
      <header className="chat__header">
        <h1>Chatbot</h1>
      </header>

      <MessageList messages={messages} status={status} />

      {status === "error" && error && <ErrorBanner message={error} onRetry={retry} />}

      <Composer disabled={status === "streaming"} onSend={send} onStop={stop} />
    </div>
  );
}
