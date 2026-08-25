export interface GithubAppStatus {
  /** This org has completed the install and has a stored installation. */
  connected: boolean;
  /** The connected installation id, or null when not connected. */
  installationId: string | null;
  /** The installation account login (org/user the App is installed on), or null. */
  account: string | null;
}

export interface GithubAppInstallUrl {
  /** The GitHub URL to send the user to, carrying a single-use signed state nonce. */
  url: string;
}
