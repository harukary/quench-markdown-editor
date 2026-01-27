import * as vscode from "vscode";
import { QuenchEditorProvider } from "./extension/QuenchEditorProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new QuenchEditorProvider(context);
  context.subscriptions.push({ dispose: () => provider.dispose() });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(QuenchEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("quench.reloadCss", async () => {
      await provider.reloadCssForAllEditors();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("quench.createThemeCss", async () => {
      await provider.createThemeCss();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("quench.openSettings", async () => {
      await provider.openSettings();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("quench.rebuildWorkspaceIndex", async () => {
      await provider.rebuildWorkspaceIndex();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("quench.insertMarkdownLink", async () => {
      await provider.insertMarkdownLink();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("quench.insertLinkToHeading", async () => {
      await provider.insertLinkToHeading();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("quench.insertImageFromFile", async () => {
      await provider.insertImageFromFile();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("quench.resizeImage", async () => {
      await provider.resizeImage();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("quench.insertEmbed", async () => {
      await provider.insertEmbed();
    })
  );
}

export function deactivate() {}
