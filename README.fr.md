# ccserver

**Langues :** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server** : serveur web de gestion du contexte des sessions CLI d'IA et de coordination entre agents.

> **Note :** il s'agit d'un outil tiers non officiel. Il n'est ni affilié aux éditeurs ou projets des CLI d'IA prises en charge, ni officiellement supporté ou approuvé par eux.

ccserver est une interface web permettant de lancer et de gérer des CLI d'IA dans un répertoire choisi : [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [opencode](https://opencode.ai/) et [OpenAI Codex CLI](https://developers.openai.com/codex/cli/). Choisissez un dossier comme dans VS Code et travaillez dans un terminal accessible depuis le navigateur.

## Architecture

```
Navigateur (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> CLI d'IA
                      <── HTTP REST ──>       (API des répertoires)
```

| Couche | Technologies |
|---|---|
| Frontend | React 19 + Vite + xterm.js |
| Backend | Node.js + Fastify + @fastify/websocket + node-pty |

## Prérequis

- Node.js >= 22.13 et npm >= 9 (utilise `node:sqlite` intégré ; le serveur ouvre SQLite (`~/.local/share/ccserver/ccserver.sqlite3`) au démarrage et refuse de démarrer avec un journal clair en cas d'échec de migration)
- Un compilateur C++ pour construire `node-pty` (`base-devel` sur Arch, `build-essential` sur Ubuntu)
- Au moins une CLI d'IA prise en charge installée sur le serveur. Seules les CLI installées sont sélectionnables.
- Facultatif : `bwrap` (bubblewrap), Docker rootless, `rootlesskit`, `uidmap` et `slirp4netns` pour toutes les fonctions du bac à sable

Installez les CLI séparément en suivant leur documentation officielle. Claude Code est également utilisé par la fonction Usage ; opencode et Codex restent utilisables sans Claude Code.

## Installation et démarrage

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
npm run setup           # simulation : affiche où iront config et état
npm run setup -- --yes  # création
```

`npm run setup` doit être exécuté une fois par hôte, y compris pour une installation neuve. Il crée
`~/.config/ccserver`, `~/.local/share/ccserver` et `~/.local/state/ccserver` (XDG) et, sur une
installation existante, déplace la configuration et l'état hors de l'arborescence du dépôt. Tant
qu'il n'a pas été exécuté, l'interface web refuse de créer de nouvelles sessions. Exécutez-le serveur arrêté. Voir [Configuration](#configuration).

### Développement

Exécutez ces commandes dans deux terminaux :

```bash
# Backend (port 3001)
npm run dev:server

# Frontend (port 5173)
npm run dev:client
```

Ouvrez <http://localhost:5173>.

### Production

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

> **Note :** Si votre shell définit `NODE_ENV=production`, `npm install` / `npm ci` ignorent les devDependencies (vite, etc.) et `npm run build --workspace=client` échoue avec `vite: not found`. Dans ce cas, installez avec `npm install --include=dev`. Les sessions lancées par ccserver n'héritent pas de `NODE_ENV` / `PORT` / `CCSERVER_*` (variables réservées au serveur, elles sont retirées).

Ouvrez <http://localhost:3001>. Le port peut être modifié avec `PORT`.

## Utilisation

1. Choisissez un dossier dans le navigateur. Un clic ouvre un dossier ; un double-clic lance l'application par défaut.
2. Utilisez le terminal intégré.
3. Choisissez Claude Code, opencode ou OpenAI Codex dans le menu. Le sandbox, la signature GPG et le transfert de l'agent SSH sont facultatifs.

L'application et les options sont mémorisées dans le navigateur. Codex reçoit sa configuration MCP par processus ; ccserver ne modifie pas `~/.codex/config.toml`.

Le bouton horloge permet de programmer des prompts. Ils persistent dans `~/.local/state/ccserver/scheduled-prompts.json` (remplaçable par `CCSERVER_SCHEDULES_PATH`) et peuvent s'exécuter après la fermeture du navigateur ou un redémarrage du serveur.

Le partage de session est facultatif (`CCSERVER_SESSION_SHARING=1`) et permet à plusieurs appareils de se connecter à la même session. Voir le [guide de partage de session](https://nananek.github.io/ccserver/guides/session-sharing/).

## Outils MCP

- `ccserver-notify` fournit `notify`, `subscribe`, `unsubscribe` et `list_subscriptions` pour Discord, les webhooks et les notifications PWA.
- `ccserver-usage` fournit `get_usage` pour consulter l'utilisation Claude Code. Il n'est injecté que dans les sessions Claude lorsque `usageMcp: true` est activé.

## Configuration

ccserver sépare ses réglages en deux, et l'appartenance se décide par une seule question :
**la sécurité d'une session déjà en cours dépend-elle de cette valeur ?** Si oui, le réglage est
statique.

- **Dynamique** -- modifiable depuis l'interface web, effet immédiat : stocké dans la table
  SQLite `settings`.
- **Statique** -- lu une seule fois au démarrage, nécessite un redémarrage, en particulier les
  frontières de sécurité (`browseRoots`, `forceSandbox`,
  `hiddenApps`) : stocké dans `~/.config/ccserver/sandbox.config.json`.

`npm run setup` crée ce fichier pour vous :

```bash
npm run setup -- --yes
$EDITOR ~/.config/ccserver/sandbox.config.json
# Chemin alternatif facultatif :
# CCSERVER_SANDBOX_CONFIG=/chemin/vers/config.json
```

Le fichier généré est volontairement minimal. Copier `server/sandbox.config.example.json` tel quel
activerait `"gpg": true`, transférant silencieusement le gpg-agent de l'hôte et `~/.gnupg` dans
chaque bac à sable ; utilisez `npm run setup -- --yes --seed-example` si vous voulez malgré tout
l'exemple complet. `server/sandbox.config.example.json` documente chaque clé et sa valeur par
défaut.

Exemple :

```json
{
  "docker": true,
  "persistentHome": true,
  "gpg": false,
  "sshAgent": false,
  "gitBroker": true,
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "usageMcp": false,
  "notify": { "discordWebhook": "", "subscriptions": [] },
  "binds": [],
  "env": {}
}
```

Les principales options sont `docker`, `persistentHome`, `gpg`, `sshAgent`, `gitBroker`, `forceSandbox`, `defaultApp`, `showUsage`, `usageMcp`, `binds` et `env`. Consultez le README japonais pour la référence complète et les limites de sécurité.

Tous les chemins utilisés par ccserver peuvent être remplacés par une variable d'environnement
(`CCSERVER_DB_PATH`, `CCSERVER_SCHEDULES_PATH`, ...) ; un chemin ainsi
défini n'est jamais touché par `npm run setup`. La liste complète, et le raisonnement derrière la
séparation dynamique/statique, se trouvent sur le site de documentation, section
Référence -> 設定モデル.

## API

Définissez `CCSERVER_TOKEN` pour protéger toutes les requêtes `/api` et `/ws`. Le client peut envoyer `?token=<TOKEN>` ou `Authorization: Bearer <TOKEN>`.

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

Pour une connexion par passkey (WebAuthn) par appareil, avec récupération par jeton à usage unique émis via SSH plutôt qu'un unique jeton partagé, définissez `CCSERVER_AUTH_MODE=passkey` (`none`/`token` restent inchangés et demeurent la valeur par défaut si non définie). Voir le [guide d'authentification](https://nananek.github.io/ccserver/guides/auth/) (en japonais) pour les contraintes d'environnement de WebAuthn.

Les endpoints REST principaux sont :

| Méthode | Chemin | Fonction |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | Lister le contenu d'un répertoire |
| GET | `/api/dirs/home` | Obtenir le HOME et les CLI disponibles |
| POST | `/api/dirs` | Créer un dossier |
| GET / DELETE | `/api/sessions[/:id]` | Lister ou arrêter des sessions |
| GET / POST | `/api/files` | Télécharger ou envoyer des fichiers |
| GET | `/api/files/content?path=<path>` | Aperçu en ligne d'un fichier `.md` / `.txt` en JSON (`{ path, name, size, mtime, kind, content, truncated }` ; premier Mio ; autres extensions et binaires refusés avec 415) |
| GET | `/api/system-stats` | Statistiques CPU, mémoire, température, GPU et stockage |
| GET | `/api/usage?force=1` | Instantané d'utilisation de Claude Code |

Les entrées/sorties du terminal et la gestion des sessions passent par `/ws/terminal` en WebSocket.

## Exécution avec systemd

Compilez le client, exécutez l'assistant de configuration, puis installez l'unité fournie :

```bash
npm run build --workspace=client
npm run setup -- --yes
mkdir -p ~/.config/systemd/user
cp docs/ccserver.service ~/.config/systemd/user/ccserver.service
systemctl --user daemon-reload
systemctl --user enable --now ccserver
systemctl --user status ccserver
```

### Mise à jour

```bash
systemctl --user stop ccserver     # migrer serveur arrêté
git pull
npm ci
npm run build --workspace=client
npm run setup                      # vérifier le plan d'abord
npm run setup -- --yes
systemctl --user start ccserver
```

Après la migration, démarrez toujours ccserver depuis une copie de travail qui inclut cette
disposition. Les branches plus anciennes résolvent les anciens chemins et démarreraient avec un
état vide.

## HTTPS avec Tailscale Serve

Une fois ccserver démarré, exposez le port 3001 à votre Tailnet :

```bash
sudo tailscale serve --bg 3001
tailscale serve status
```

## Licence

MIT
