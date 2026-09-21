import { renderPage } from "./layout.js";

export interface LoginPageOptions {
  expired?: boolean;
  invalidCredentials?: boolean;
}

export function renderLoginPage({ expired = false, invalidCredentials = false }: LoginPageOptions = {}): string {
  const notices: string[] = [];
  if (expired) {
    notices.push(`        <p role="alert">Your session expired. Please log in again.</p>\n`);
  }
  if (invalidCredentials) {
    notices.push(`        <p role="alert">Invalid username or password.</p>\n`);
  }

  const bodyHtml = `${notices.join("")}        <form method="post" action="/login">
          <table>
            <tbody>
              <tr>
                <td><label for="username">Username</label></td>
                <td><input id="username" name="username" type="text" autocomplete="username"></td>
              </tr>
              <tr>
                <td><label for="password">Password</label></td>
                <td><input id="password" name="password" type="password" autocomplete="current-password"></td>
              </tr>
            </tbody>
          </table>
          <button type="submit">Log In</button>
        </form>
`;

  return renderPage({ title: "Log In", bodyHtml });
}
