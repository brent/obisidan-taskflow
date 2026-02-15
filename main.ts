// main.ts
import { App, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { formatInTimeZone } from 'date-fns-tz';

// Define the interface for our plugin settings
interface TaskflowPluginSettings {
  propertyName: string;
  trueFolder: string;
  falseFolder: string;
  enableCompletedDate: boolean;
  completedDatePropertyName: string;
}

// Define default settings for the plugin
const DEFAULT_SETTINGS: TaskflowPluginSettings = {
  propertyName: 'completed',
  trueFolder: '02 - Completed',
  falseFolder: '01 - Inbox',
  enableCompletedDate: false,
  completedDatePropertyName: 'completed_date',
};

// Main plugin class
export default class TaskflowPlugin extends Plugin {
  settings: TaskflowPluginSettings = DEFAULT_SETTINGS;

  /**
   * Called when the plugin is loaded.
   */
  async onload() {
    await this.loadSettings();

    this.addSettingTab(new TaskflowSettingTab(this.app, this));

    // ✅ FIX: Use the 'metadataCache.changed' event for instant frontmatter updates.
    // This is more reliable than 'vault.modify'.
    this.registerEvent(
      this.app.metadataCache.on('changed', async (file) => {
        // This event gives us the file that changed, which is all we need.
        await this.processFile(file);
      })
    );
  }

  /**
   * Called when the plugin is unloaded.
   */
  onunload() { }

  /**
   * Loads settings from Obsidian's data storage.
   */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * Saves the current plugin settings to disk.
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Processes a given Markdown file to determine if it needs to be moved.
   * @param file The TFile object representing the Markdown file.
   */
  private processing = new Set<string>();
  async processFile(file: TFile) {
    const originalPath = file.path;
    if (this.processing.has(originalPath)) {
      return;
    }

    this.processing.add(originalPath);

    try {
      const { propertyName, trueFolder, falseFolder, enableCompletedDate, completedDatePropertyName } = this.settings;

      if (!propertyName || !trueFolder || !falseFolder) {
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
        targetFolder = trueFolder;
      } else if (propertyValue === false) {
        targetFolder = falseFolder;
      } else {
        return; // Property not found or not a boolean.
      }

      const currentFolderPath = file.parent?.path || '';
      if (currentFolderPath === targetFolder) {
        return; // Already in the correct folder.
      }

      const newPath = `${targetFolder}/${file.name}`;

      const targetFolderAbstractFile = this.app.vault.getAbstractFileByPath(targetFolder);
      if (!targetFolderAbstractFile) {
        await this.app.vault.createFolder(targetFolder);
      } else if (targetFolderAbstractFile instanceof TFile) {
        console.error(`Taskflow Plugin: Target path "${targetFolder}" is a file, not a folder.`);
        return;
      }

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
      .setName('Checkbox Property Name')
      .setDesc('The name of the frontmatter property (e.g., "completed") that will trigger the file move.')
      .addText(text => text
        .setPlaceholder('completed')
        .setValue(this.plugin.settings.propertyName)
        .onChange(async (value) => {
          this.plugin.settings.propertyName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Folder for "True" value')
      .setDesc('The folder where the file will be moved when the property is set to `true`.')
      .addText(text => text
        .setPlaceholder('02 - Completed')
        .setValue(this.plugin.settings.trueFolder)
        .onChange(async (value) => {
          this.plugin.settings.trueFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Folder for "False" value (Original)')
      .setDesc('The folder where the file will be moved back to when the property is set to `false`.')
      .addText(text => text
        .setPlaceholder('01 - Inbox')
        .setValue(this.plugin.settings.falseFolder)
        .onChange(async (value) => {
          this.plugin.settings.falseFolder = value;
          await this.plugin.saveSettings();
        }));

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
