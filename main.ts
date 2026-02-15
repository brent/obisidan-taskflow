// main.ts
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { formatInTimeZone } from 'date-fns-tz';

// Define the interface for our plugin settings
interface TaskflowPluginSettings {
  rootFolder: string;
  templatePath: string;
  propertyName: string;
  trueFolder: string;
  falseFolder: string;
  iceboxFolder: string;
  enableBacklog: boolean;
  backlogFolder: string;
  enableCompletedDate: boolean;
  completedDatePropertyName: string;
  taskCounter: number;
}

// Define default settings for the plugin
const DEFAULT_SETTINGS: TaskflowPluginSettings = {
  rootFolder: 'taskflow',
  templatePath: '',
  propertyName: '✅',
  trueFolder: 'archive',
  falseFolder: '',
  iceboxFolder: 'icebox',
  enableBacklog: false,
  backlogFolder: 'backlog',
  enableCompletedDate: false,
  completedDatePropertyName: 'completed_date',
  taskCounter: 1,
};

// Builds an absolute vault path from a root and a relative sub-path.
// If sub is empty, returns root. If root is empty, sub is treated as absolute.
function buildPath(root: string, sub: string): string {
  if (!root) return sub;
  if (!sub) return root;
  return `${root}/${sub}`;
}

// Main plugin class
export default class TaskflowPlugin extends Plugin {
  settings: TaskflowPluginSettings = DEFAULT_SETTINGS;

  /**
   * Called when the plugin is loaded.
   */
  async onload() {
    const needsCounterScan = await this.loadSettings();

    this.addSettingTab(new TaskflowSettingTab(this.app, this));

    this.addCommand({
      id: 'create-task',
      name: 'Create task',
      callback: () => new CreateTaskModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'move-to-icebox',
      name: 'Move current task to icebox',
      callback: () => this.moveToIcebox(),
    });

    this.addCommand({
      id: 'move-out-of-backlog',
      name: 'Move current task out of backlog',
      checkCallback: (checking) => {
        if (!this.settings.enableBacklog) return false;
        if (checking) return true;
        this.moveOutOfBacklog();
        return true;
      },
    });

    // ✅ FIX: Use the 'metadataCache.changed' event for instant frontmatter updates.
    // This is more reliable than 'vault.modify'.
    this.registerEvent(
      this.app.metadataCache.on('changed', async (file) => {
        // This event gives us the file that changed, which is all we need.
        await this.processFile(file);
      })
    );

    // Scan for the highest existing task number on first install or when
    // upgrading from a version that didn't persist the counter.
    if (needsCounterScan) {
      this.app.workspace.onLayoutReady(() => this.detectTaskCounter());
    }
  }

  /**
   * Called when the plugin is unloaded.
   */
  onunload() { }

  /**
   * Loads settings from Obsidian's data storage.
   * Returns true if taskCounter was absent (fresh install or legacy data),
   * indicating that detectTaskCounter() should be run.
   */
  async loadSettings(): Promise<boolean> {
    const savedData = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
    return !savedData || !('taskCounter' in savedData);
  }

  /**
   * Saves the current plugin settings to disk.
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Scans the root folder for existing task files and sets taskCounter to
   * one above the highest TASK number found. Falls back to 1 if none exist.
   */
  async detectTaskCounter(): Promise<void> {
    const { rootFolder } = this.settings;
    const files = this.app.vault.getMarkdownFiles();
    let maxNum = 0;

    for (const file of files) {
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) continue;
      const match = file.name.match(/^\[TASK-(\d+)\]/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }

    this.settings.taskCounter = maxNum + 1;
    await this.saveSettings();
  }

  /**
   * Moves the currently active task file to the configured icebox folder.
   */
  async moveToIcebox() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    if (!activeFile.name.startsWith('[TASK-')) {
      new Notice('Taskflow: Active file is not a task file.');
      return;
    }

    const { rootFolder, iceboxFolder } = this.settings;
    const absoluteIcebox = buildPath(rootFolder, iceboxFolder);
    if (!absoluteIcebox) {
      new Notice('Taskflow: Icebox folder is not configured.');
      return;
    }

    const currentFolder = activeFile.parent?.path || '';
    if (currentFolder === absoluteIcebox) {
      new Notice('Taskflow: File is already in the icebox.');
      return;
    }

    const newPath = `${absoluteIcebox}/${activeFile.name}`;
    await this.ensureFolder(absoluteIcebox);
    await this.app.vault.rename(activeFile, newPath);
    new Notice('Taskflow: Moved to icebox.');
  }

  /**
   * Moves the currently active task file from the backlog to the root folder.
   */
  async moveOutOfBacklog() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    if (!activeFile.name.startsWith('[TASK-')) {
      new Notice('Taskflow: Active file is not a task file.');
      return;
    }

    const { rootFolder } = this.settings;
    const targetFolder = rootFolder || '';
    const currentFolder = activeFile.parent?.path || '';

    if (currentFolder === targetFolder) {
      new Notice('Taskflow: File is already in the root folder.');
      return;
    }

    const newPath = targetFolder
      ? `${targetFolder}/${activeFile.name}`
      : activeFile.name;
    await this.ensureFolder(targetFolder);
    await this.app.vault.rename(activeFile, newPath);
    new Notice('Taskflow: Moved out of backlog.');
  }

  /**
   * Ensures a folder path exists, creating any missing intermediate directories.
   */
  async ensureFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  /**
   * Processes a given Markdown file to determine if it needs to be moved.
   * @param file The TFile object representing the Markdown file.
   */
  processing = new Set<string>();
  async processFile(file: TFile) {
    const originalPath = file.path;
    if (this.processing.has(originalPath)) {
      return;
    }

    this.processing.add(originalPath);

    try {
      const { rootFolder, propertyName, trueFolder, falseFolder, enableCompletedDate, completedDatePropertyName } = this.settings;

      // If a root folder is configured, only process files inside it.
      if (rootFolder && !file.path.startsWith(`${rootFolder}/`)) {
        return;
      }

      const absoluteTrueFolder = buildPath(rootFolder, trueFolder);
      const absoluteFalseFolder = buildPath(rootFolder, falseFolder);

      if (!propertyName || !absoluteTrueFolder || !absoluteFalseFolder) {
        console.warn('Taskflow Plugin: Settings are incomplete.');
        return;
      }

      const fileCache = this.app.metadataCache.getFileCache(file);
      if (!fileCache || !fileCache.frontmatter) {
        return; // No frontmatter, so nothing to do.
      }

      const propertyValue = fileCache.frontmatter[propertyName];
      let targetFolder = '';

      if (propertyValue === true) {
        targetFolder = absoluteTrueFolder;
      } else if (propertyValue === false) {
        targetFolder = absoluteFalseFolder;
      } else {
        return; // Property not found or not a boolean.
      }

      const currentFolderPath = file.parent?.path || '';
      if (currentFolderPath === targetFolder) {
        return; // Already in the correct folder.
      }

      const newPath = `${targetFolder}/${file.name}`;

      await this.ensureFolder(targetFolder);

      // 1. Move the file first.
      await this.app.vault.rename(file, newPath);
      console.log(`Taskflow Plugin: Moved "${originalPath}" to "${newPath}"`);

      // 2. Then, modify the frontmatter in the new location.
      if (enableCompletedDate && completedDatePropertyName) {
        if (propertyValue === true) {
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            if (!frontmatter[completedDatePropertyName]) {
              const now = new Date();
              const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              frontmatter[completedDatePropertyName] = formatInTimeZone(now, timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
            }
          });
        } else if (propertyValue === false) {
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            delete frontmatter[completedDatePropertyName];
          });
        }
      }

    } catch (e) {
      console.error(`Taskflow Plugin: Error processing "${originalPath}":`, e);
    } finally {
      this.processing.delete(originalPath);
    }
  }
}

class CreateTaskModal extends Modal {
  plugin: TaskflowPlugin;

  constructor(app: App, plugin: TaskflowPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'New task' });

    const input = contentEl.createEl('input', { type: 'text' });
    input.placeholder = 'Task title';
    input.style.width = '100%';
    input.style.marginBottom = '1em';

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') await this.createTask(input.value);
    });

    const button = contentEl.createEl('button', { text: 'Create' });
    button.addEventListener('click', async () => await this.createTask(input.value));

    // Focus the input after the modal finishes animating open.
    setTimeout(() => input.focus(), 50);
  }

  async createTask(title: string) {
    title = title.trim();
    if (!title) return;

    const { rootFolder, taskCounter, propertyName, templatePath, enableBacklog, backlogFolder } = this.plugin.settings;
    const paddedNum = String(taskCounter).padStart(3, '0');
    const fileName = `[TASK-${paddedNum}] ${title}.md`;
    const targetFolder = enableBacklog
      ? buildPath(rootFolder, backlogFolder)
      : (rootFolder || '');
    const filePath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    let content: string;
    const templateFile = templatePath
      ? this.app.vault.getAbstractFileByPath(templatePath)
      : null;
    if (templateFile instanceof TFile) {
      content = await this.app.vault.read(templateFile);
    } else {
      content = [
        '---',
        `${propertyName}: false`,
        '🚩: false',
        'due: ',
        'defer: ',
        'started: ',
        '---',
        '',
      ].join('\n');
    }

    await this.plugin.ensureFolder(targetFolder);

    // Suppress processFile from reacting to the newly created file.
    this.plugin.processing.add(filePath);
    const file = await this.app.vault.create(filePath, content);
    setTimeout(() => this.plugin.processing.delete(filePath), 500);

    // Increment and persist the counter.
    this.plugin.settings.taskCounter = taskCounter + 1;
    await this.plugin.saveSettings();

    this.close();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Settings tab class remains the same
class TaskflowSettingTab extends PluginSettingTab {
  plugin: TaskflowPlugin;

  constructor(app: App, plugin: TaskflowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Taskflow settings' });

    new Setting(containerEl)
      .setName('Root Folder')
      .setDesc('Scope the plugin to files inside this folder. The "True" and "False" folder paths below are relative to this root. Leave empty to watch the entire vault (folder paths will be treated as absolute).')
      .addText(text => text
        .setPlaceholder('taskflow')
        .setValue(this.plugin.settings.rootFolder)
        .onChange(async (value) => {
          this.plugin.settings.rootFolder = value;
          await this.plugin.saveSettings();
          await this.plugin.detectTaskCounter();
        }));

    new Setting(containerEl)
      .setName('Task Template')
      .setDesc('Path to a template file used when creating tasks. Falls back to the default frontmatter if the file does not exist. The file will not be created automatically.')
      .addText(text => text
        .setPlaceholder('templates/task.md')
        .setValue(this.plugin.settings.templatePath)
        .onChange(async (value) => {
          this.plugin.settings.templatePath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Checkbox Property Name')
      .setDesc('The name of the frontmatter property (e.g., "completed") that will trigger the file move.')
      .addText(text => text
        .setPlaceholder('✅')
        .setValue(this.plugin.settings.propertyName)
        .onChange(async (value) => {
          this.plugin.settings.propertyName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Folder for "True" value')
      .setDesc('The folder where the file will be moved when the property is set to `true`. Relative to Root Folder if one is set.')
      .addText(text => text
        .setPlaceholder('archive')
        .setValue(this.plugin.settings.trueFolder)
        .onChange(async (value) => {
          this.plugin.settings.trueFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Folder for "False" value (Original)')
      .setDesc('The folder where the file will be moved back to when the property is set to `false`. Relative to Root Folder if one is set. Leave blank to use the Root Folder itself.')
      .addText(text => text
        .setPlaceholder('Leave blank to use Root Folder')
        .setValue(this.plugin.settings.falseFolder)
        .onChange(async (value) => {
          this.plugin.settings.falseFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Icebox Folder')
      .setDesc('Files moved to the icebox are placed here. Relative to Root Folder if one is set. Leave blank to use the Root Folder itself.')
      .addText(text => text
        .setPlaceholder('icebox')
        .setValue(this.plugin.settings.iceboxFolder)
        .onChange(async (value) => {
          this.plugin.settings.iceboxFolder = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Backlog Settings' });

    new Setting(containerEl)
      .setName('Enable Backlog')
      .setDesc('When enabled, new tasks are created in the backlog folder instead of the root. A command to move tasks out of the backlog becomes available.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableBacklog)
        .onChange(async (value) => {
          this.plugin.settings.enableBacklog = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.enableBacklog) {
      new Setting(containerEl)
        .setName('Backlog Folder')
        .setDesc('New tasks are created here. Relative to Root Folder if one is set.')
        .addText(text => text
          .setPlaceholder('backlog')
          .setValue(this.plugin.settings.backlogFolder)
          .onChange(async (value) => {
            this.plugin.settings.backlogFolder = value;
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl('h3', { text: 'Completed Date Settings' });

    new Setting(containerEl)
      .setName('Enable Completed Date')
      .setDesc('When a checkbox property is checked, add a completed date property.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableCompletedDate)
        .onChange(async (value) => {
          this.plugin.settings.enableCompletedDate = value;
          await this.plugin.saveSettings();
          this.display(); // Refresh the settings pane
        }));

    if (this.plugin.settings.enableCompletedDate) {
      new Setting(containerEl)
        .setName('Completed Date Property Name')
        .setDesc('The name of the frontmatter property to store the completed date.')
        .addText(text => text
          .setPlaceholder('completed_date')
          .setValue(this.plugin.settings.completedDatePropertyName)
          .onChange(async (value) => {
            this.plugin.settings.completedDatePropertyName = value;
            await this.plugin.saveSettings();
          }));
    }
  }
}
