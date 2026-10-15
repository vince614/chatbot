import type { ChatUser } from "./api";

export type UsersState = "loading" | "ready" | "error";

interface UserSelectProps {
  users: ChatUser[];
  state: UsersState;
  /** Identifiant choisi ; chaîne vide tant qu'aucun utilisateur n'est sélectionné. */
  value: string;
  onChange: (userId: string) => void;
}

export function UserSelect({ users, state, value, onChange }: UserSelectProps) {
  return (
    <div className="user-select">
      <label htmlFor="user-select">Utilisateur</label>
      <select
        id="user-select"
        className="user-select__input"
        value={value}
        disabled={state !== "ready"}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{state === "loading" ? "Chargement…" : "Choisir un utilisateur…"}</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.nom}
          </option>
        ))}
      </select>
      {state === "error" && (
        <span className="user-select__error" role="alert">
          Liste indisponible
        </span>
      )}
    </div>
  );
}
