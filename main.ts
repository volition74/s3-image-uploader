import {
	App,
	Editor,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextComponent,
	setIcon,
	FileSystemAdapter,
	RequestUrlParam,
	requestUrl,
	TFile,
	MarkdownView,
} from "obsidian";
import { HttpRequest, HttpResponse } from "@aws-sdk/protocol-http";
import { HttpHandlerOptions } from "@aws-sdk/types";
import { buildQueryString } from "@aws-sdk/querystring-builder";
import { requestTimeout } from "@smithy/fetch-http-handler/dist-es/request-timeout";

import {
	FetchHttpHandler,
	FetchHttpHandlerOptions,
} from "@smithy/fetch-http-handler";

import { filesize } from "filesize";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import imageCompression from "browser-image-compression";
import { minimatch } from "minimatch";

// Remember to rename these classes and interfaces!!

interface pasteFunction {
	(
		this: HTMLElement,
		event: ClipboardEvent | DragEvent,
		editor: Editor,
	): void;
}

interface S3UploaderSettings {
	accessKey: string;
	secretKey: string;
	region: string;
	bucket: string;
	folder: string;
	imageUrlPath: string;
	uploadOnDrag: boolean;
	localUpload: boolean;
	localUploadFolder: string;
	uploadLocalNoteImages: boolean;
	deleteLocalImagesAfterUpload: boolean;
	useCustomEndpoint: boolean;
	customEndpoint: string;
	forcePathStyle: boolean;
	useCustomImageUrl: boolean;
	customImageUrl: string;
	uploadVideo: boolean;
	uploadAudio: boolean;
	uploadPdf: boolean;
	bypassCors: boolean;
	queryStringValue: string;
	queryStringKey: string;
	enableImageCompression: boolean;
	maxImageCompressionSize: number;
	imageCompressionQuality: number;
	maxImageWidthOrHeight: number;
	ignorePattern: string;
	disableAutoUploadOnCreate: boolean;
}

const DEFAULT_SETTINGS: S3UploaderSettings = {
	accessKey: "",
	secretKey: "",
	region: "",
	bucket: "",
	folder: "",
	imageUrlPath: "",
	uploadOnDrag: true,
	localUpload: false,
	localUploadFolder: "",
	uploadLocalNoteImages: true,
	deleteLocalImagesAfterUpload: false,
	useCustomEndpoint: false,
	customEndpoint: "",
	forcePathStyle: false,
	useCustomImageUrl: false,
	customImageUrl: "",
	uploadVideo: false,
	uploadAudio: false,
	uploadPdf: false,
	bypassCors: false,
	queryStringValue: "",
	queryStringKey: "",
	enableImageCompression: false,
	maxImageCompressionSize: 1,
	imageCompressionQuality: 0.7,
	maxImageWidthOrHeight: 4096,
	ignorePattern: "",
	disableAutoUploadOnCreate: false,
};

export default class S3UploaderPlugin extends Plugin {
	settings: S3UploaderSettings;
	s3: S3Client;
	pasteFunction: pasteFunction;

	private async replaceText(
		editor: Editor,
		target: string,
		replacement: string,
	): Promise<void> {
		const content = editor.getValue();
		const position = content.indexOf(target);

		console.log("replaceText called:", { target, replacement });

		if (position !== -1) {
			console.log("Target found at position:", position);

			// Check if we're in a table by looking for pipe characters around the target
			const surroundingBefore = content.substring(
				Math.max(0, position - 20),
				position,
			);
			const surroundingAfter = content.substring(
				position + target.length,
				Math.min(content.length, position + target.length + 20),
			);

			console.log("Surrounding text:", {
				before: surroundingBefore,
				after: surroundingAfter,
			});

			const isInTable =
				surroundingBefore.includes("|") &&
				surroundingAfter.includes("|");
			console.log("Is in table:", isInTable);

			// For tables, we need to be more careful with the replacement
			if (isInTable) {
				// Get the line containing the target
				const from = editor.offsetToPos(position);
				const to = editor.offsetToPos(position + target.length);

				console.log("Table replacement positions:", { from, to });

				try {
					// Use a more direct approach for tables
					editor.transaction({
						changes: [
							{
								from,
								to,
								text: replacement,
							},
						],
					});
					console.log("Table transaction completed");

					// Force a refresh of the editor to ensure the table renders correctly
					setTimeout(() => {
						try {
							editor.refresh();
							console.log("Editor refreshed");
						} catch (e) {
							console.error("Error refreshing editor:", e);
						}
					}, 100); // Increased timeout for better reliability
				} catch (e) {
					console.error("Error during table transaction:", e);
				}
			} else {
				// Normal replacement for non-table content
				const from = editor.offsetToPos(position);
				const to = editor.offsetToPos(position + target.length);

				console.log("Normal replacement positions:", { from, to });

				try {
					editor.transaction({
						changes: [
							{
								from,
								to,
								text: replacement,
							},
						],
					});
					console.log("Normal transaction completed");
				} catch (e) {
					console.error("Error during normal transaction:", e);
				}
			}
		} else {
			console.log("Target not found in content");
		}
	}

	private shouldIgnoreCurrentFile(): boolean {
		const noteFile = this.app.workspace.getActiveFile();
		if (!noteFile || !this.settings.ignorePattern) {
			return false;
		}

		const filePath = noteFile.path;
		return matchesGlobPattern(filePath, this.settings.ignorePattern);
	}

	async uploadFile(file: File, key: string): Promise<string> {
		// Check if S3 client is initialized
		if (!this.s3) {
			throw new Error(
				"S3 client not configured. Please configure the plugin settings first.",
			);
		}

		const buf = await file.arrayBuffer();
		await this.s3.send(
			new PutObjectCommand({
				Bucket: this.settings.bucket,
				Key: key,
				Body: new Uint8Array(buf),
				ContentType: file.type,
			}),
		);
		let urlString = this.settings.imageUrlPath + key;
		if (this.settings.queryStringKey && this.settings.queryStringValue) {
			const urlObject = new URL(urlString);

			// The searchParams property provides methods to manipulate query parameters
			urlObject.searchParams.append(
				this.settings.queryStringKey,
				this.settings.queryStringValue,
			);
			urlString = urlObject.toString();
		}
		return urlString;
	}

	async compressImage(file: File): Promise<ArrayBuffer> {
		const compressedFile = await imageCompression(file, {
			useWebWorker: false,
			maxWidthOrHeight: this.settings.maxImageWidthOrHeight,
			maxSizeMB: this.settings.maxImageCompressionSize,
			initialQuality: this.settings.imageCompressionQuality,
		});

		const fileBuffer = await compressedFile.arrayBuffer();
		const originalSize = filesize(file.size); // Input file size
		const newSize = filesize(compressedFile.size);

		new Notice(`Image compressed from ${originalSize} to ${newSize}`);

		return fileBuffer;
	}

	async pasteHandler(
		ev: ClipboardEvent | DragEvent | Event | null,
		editor: Editor,
		directFile?: File,
	): Promise<void> {
		if (ev?.defaultPrevented) {
			return;
		}

		const noteFile = this.app.workspace.getActiveFile();
		if (!noteFile || !noteFile.name) return;

		const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
		const localUpload = fm?.localUpload ?? this.settings.localUpload;
		const uploadVideo = fm?.uploadVideo ?? this.settings.uploadVideo;
		const uploadAudio = fm?.uploadAudio ?? this.settings.uploadAudio;
		const uploadPdf = fm?.uploadPdf ?? this.settings.uploadPdf;

		let files: File[] = [];
		if (directFile) {
			files = [directFile];
		} else if (ev) {
			switch (ev.type) {
				case "paste":
					files = Array.from(
						(ev as ClipboardEvent).clipboardData?.files || [],
					);
					break;
				case "drop":
					if (
						!this.settings.uploadOnDrag &&
						!(fm && fm.uploadOnDrag)
					) {
						return;
					}
					files = Array.from(
						(ev as DragEvent).dataTransfer?.files || [],
					);
					break;
				case "input":
					files = Array.from(
						(ev.target as HTMLInputElement).files || [],
					);
					break;
			}
		}

		// Only prevent default and proceed if we have files to handle AND file is not ignored
		if (files.length > 0) {
			// Check if uploads should be ignored for this file AFTER we know there are files
			// but BEFORE we prevent default behavior
			if (this.shouldIgnoreCurrentFile()) {
				return; // Let default Obsidian behavior handle the files
			}

			if (ev) ev.preventDefault();
			new Notice("Uploading files...");

			// Remember cursor position before any changes
			const cursorPos = editor.getCursor();

			const uploads = files.map(async (file) => {
				let thisType = "";
				if (file.type.match(/video.*/) && uploadVideo) {
					thisType = "video";
				} else if (file.type.match(/audio.*/) && uploadAudio) {
					thisType = "audio";
				} else if (file.type.match(/application\/pdf/) && uploadPdf) {
					thisType = "pdf";
				} else if (file.type.match(/image.*/)) {
					thisType = "image";
				} else if (
					file.type.match(/presentation.*/) ||
					file.type.match(/powerpoint.*/)
				) {
					thisType = "ppt";
				}
				if (!thisType) {
					return;
				}

				// Process the file
				let buf = await file.arrayBuffer();
				const digest = await generateFileHash(new Uint8Array(buf));
				const newFileName = `${digest}.${file.name.split(".").pop()}`;

				// Determine folder
				let folder = "";
				if (localUpload) {
					folder =
						fm?.uploadFolder ?? this.settings.localUploadFolder;
				} else {
					folder = fm?.uploadFolder ?? this.settings.folder;
				}

				const currentDate = new Date();

				folder = folder
					.replace("${year}", currentDate.getFullYear().toString())
					.replace(
						"${month}",
						String(currentDate.getMonth() + 1).padStart(2, "0"),
					)
					.replace(
						"${day}",
						String(currentDate.getDate()).padStart(2, "0"),
					)
					.replace(
						"${basename}",
						noteFile.basename.replace(/ /g, "-"),
					);

				const key = folder ? `${folder}/${newFileName}` : newFileName;

				try {
					// Upload the file
					let url;

					// Image compression
					if (
						thisType === "image" &&
						this.settings.enableImageCompression
					) {
						buf = await this.compressImage(file);
						file = new File([buf], newFileName, {
							type: file.type,
						});
					}

					if (!localUpload) {
						url = await this.uploadFile(file, key);
					} else {
						await this.app.vault.adapter.writeBinary(
							key,
							new Uint8Array(buf),
						);
						url =
							this.app.vault.adapter instanceof FileSystemAdapter
								? this.app.vault.adapter.getFilePath(key)
								: key;
					}

					// Generate the markdown
					return wrapFileDependingOnType(url, thisType, "");
				} catch (error) {
					console.error(error);
					return `Error uploading file: ${error.message}`;
				}
			});

			try {
				// Wait for all uploads to complete
				const results = await Promise.all(uploads);

				// Filter out undefined results (from unsupported file types)
				const validResults = results.filter(
					(result) => result !== undefined,
				);

				// Insert all results at once at the cursor position
				if (validResults.length > 0) {
					// Use a safer approach to insert text
					const text = validResults.join("\n");

					// Use transaction API instead of replaceSelection
					editor.transaction({
						changes: [
							{
								from: cursorPos,
								text: text,
							},
						],
					});

					new Notice("All files uploaded successfully");
				}
			} catch (error) {
				console.error("Error during upload or insertion:", error);
				new Notice(`Error: ${error.message}`);
			}
		}
	}

	private async uploadExternalImagesInCurrentNote(
		editor: Editor,
	): Promise<void> {
		const noteFile = this.app.workspace.getActiveFile();
		if (!noteFile) {
			new Notice("No active note found.");
			return;
		}

		if (this.shouldIgnoreCurrentFile()) {
			new Notice("Current note is ignored by the plugin ignore pattern.");
			return;
		}

		const content = editor.getValue();
		const references = this.parseExternalImageReferences(content);
		if (references.length === 0) {
			new Notice("No image links found in the current note.");
			return;
		}

		const filteredReferences = references.filter(
			(item) =>
				(item.source === "external" &&
					!item.url.includes("amazonaws.com")) ||
				(item.source === "local" &&
					this.settings.uploadLocalNoteImages),
		);

		if (filteredReferences.length === 0) {
			new Notice(
				"Local image upload is disabled in settings, and there are no external image links to upload.",
			);
			return;
		}

		new Notice(`Uploading ${filteredReferences.length} image(s)...`);

		const localUpload =
			this.app.metadataCache.getFileCache(noteFile)?.frontmatter
				?.localUpload ?? this.settings.localUpload;

		const uploadResults: Array<{
			item: {
				source: "external" | "local";
				format: "markdown" | "html";
				fullMatch: string;
				url: string;
				alt: string;
				title: string;
				start: number;
				end: number;
			};
			url: string;
			localFilePath?: string;
		}> = [];

		for (const item of filteredReferences) {
			try {
				let file: File;
				let localFilePath: string | undefined;

				if (item.source === "external") {
					file = await this.downloadRemoteFile(item.url);
				} else {
					const local = await this.loadLocalImageFile(item.url, noteFile);
					file = local.file;
					localFilePath = local.sourceFile.path;
				}

				const url = await this.uploadImageFile(
					file,
					noteFile,
					localUpload,
				);
				uploadResults.push({ item, url, localFilePath });
			} catch (error) {
				console.error("Failed to upload image", item.url, error);
			}
		}

		if (uploadResults.length === 0) {
			new Notice("No images were uploaded.");
			return;
		}

		const changes = uploadResults
			.sort((a, b) => b.item.start - a.item.start)
			.map(({ item, url }) => {
				const replacement =
					item.format === "markdown"
						? `![${item.alt}](${url}${
							item.title ? ` "${item.title}"` : ""
						})`
						: item.fullMatch.replace(
							/src=(['"])([^'"]+)\1/i,
							`src=$1${url}$1`,
						);
				return {
					from: editor.offsetToPos(item.start),
					to: editor.offsetToPos(item.end),
					text: replacement,
				};
			});

		editor.transaction({ changes });

		if (this.settings.deleteLocalImagesAfterUpload) {
			const pathsToDelete = new Set(
				uploadResults
					.filter((result) => result.localFilePath)
					.map((result) => result.localFilePath as string),
			);
			for (const path of pathsToDelete) {
				const localFile = this.app.vault.getAbstractFileByPath(path);
				if (localFile instanceof TFile) {
					await this.app.vault.delete(localFile);
				}
			}
		}

		new Notice(
			`Uploaded ${uploadResults.length} image(s) in current note.`,
		);
	}

	private parseExternalImageReferences(
		content: string,
	): Array<{
		source: "external" | "local";
		format: "markdown" | "html";
		fullMatch: string;
		url: string;
		alt: string;
		title: string;
		start: number;
		end: number;
	}> {
		const references: Array<{
		source: "external" | "local";
		format: "markdown" | "html";
		fullMatch: string;
		url: string;
		alt: string;
		title: string;
		start: number;
		end: number;
	}> = [];

		const markdownExternalRegex = /!\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+?)(?:\s+["']([^"']*)["'])?\s*\)/g;
		let markdownMatch: RegExpExecArray | null;
		while ((markdownMatch = markdownExternalRegex.exec(content))) {
			references.push({
				source: "external",
				format: "markdown",
				fullMatch: markdownMatch[0],
				url: markdownMatch[2],
				alt: markdownMatch[1] ?? "",
				title: markdownMatch[3] ?? "",
				start: markdownMatch.index,
				end: markdownMatch.index + markdownMatch[0].length,
			});
		}

		const markdownLocalRegex = /!\[([^\]]*)\]\(\s*([^\s)]+?)\s*\)/g;
		while ((markdownMatch = markdownLocalRegex.exec(content))) {
			const source = markdownMatch[2];
			if (/^(https?:\/\/|data:|file:)/i.test(source)) {
				continue;
			}
			references.push({
				source: "local",
				format: "markdown",
				fullMatch: markdownMatch[0],
				url: source,
				alt: markdownMatch[1] ?? "",
				title: "",
				start: markdownMatch.index,
				end: markdownMatch.index + markdownMatch[0].length,
			});
		}

		const wikiImageRegex = /!\[\[([^\]\|]+)(?:\|([^\]]*))?\]\]/g;
		let wikiMatch: RegExpExecArray | null;
		while ((wikiMatch = wikiImageRegex.exec(content))) {
			references.push({
				source: "local",
				format: "markdown",
				fullMatch: wikiMatch[0],
				url: wikiMatch[1].trim(),
				alt: wikiMatch[2] ?? "",
				title: "",
				start: wikiMatch.index,
				end: wikiMatch.index + wikiMatch[0].length,
			});
		}

		const htmlRegex = /<img\s+[^>]*src=(['"])([^"']+)\1[^>]*>/gi;
		let htmlMatch: RegExpExecArray | null;
		while ((htmlMatch = htmlRegex.exec(content))) {
			const fullMatch = htmlMatch[0];
			const src = htmlMatch[2];
			const altMatch = /alt=(['"])(.*?)\1/i.exec(fullMatch);
			references.push({
				source: /^(https?:\/\/|data:|file:)/i.test(src) ? "external" : "local",
				format: "html",
				fullMatch,
				url: src,
				alt: altMatch?.[2] ?? "",
				title: "",
				start: htmlMatch.index,
				end: htmlMatch.index + fullMatch.length,
			});
		}

		return references;
	}

	private async loadLocalImageFile(
		source: string,
		noteFile: TFile,
	): Promise<{ file: File; sourceFile: TFile }> {
		const vaultPath = this.resolveLocalVaultPath(noteFile.path, source);
		const localFile = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(localFile instanceof TFile)) {
			throw new Error(`Local image file not found: ${source}`);
		}

		const fileContent = await this.app.vault.readBinary(localFile);
		const buffer =
			ArrayBuffer.isView(fileContent) || fileContent instanceof ArrayBuffer
				? fileContent
				: new Uint8Array(fileContent).buffer;
		const contentType = this.getContentTypeFromName(localFile.name);
		return {
			file: new File([buffer], localFile.name, { type: contentType }),
			sourceFile: localFile,
		};
	}

	private resolveLocalVaultPath(notePath: string, source: string): string {
		const normalized = source.replace(/\\/g, "/").trim().replace(/^\/+/, "");
		if (normalized.startsWith("./") || normalized.startsWith("../")) {
			const folder = notePath.includes("/")
				? notePath.slice(0, notePath.lastIndexOf("/"))
				: "";
			const parts = folder ? folder.split("/") : [];
			for (const segment of normalized.split("/")) {
				if (segment === "." || segment === "") {
					continue;
				}
				if (segment === "..") {
					parts.pop();
					continue;
				}
				parts.push(segment);
			}
			return parts.join("/");
		}

		const noteFolder = notePath.includes("/")
			? notePath.slice(0, notePath.lastIndexOf("/"))
			: "";
		const relativePath = noteFolder ? `${noteFolder}/${normalized}` : normalized;
		const relativeFile = this.app.vault.getAbstractFileByPath(relativePath);
		if (relativeFile instanceof TFile) {
			return relativePath;
		}

		const matchedFile = this.findVaultFileByShortPath(normalized, noteFolder);
		return matchedFile?.path || normalized;
	}

	private findVaultFileByShortPath(
		shortPath: string,
		noteFolder: string,
	): TFile | null {
		const normalized = shortPath.replace(/^\/+/, "");
		const candidates = this.app.vault
			.getFiles()
			.filter((file) =>
				file.path === normalized || file.path.endsWith(`/${normalized}`),
			);
		if (candidates.length === 1) {
			return candidates[0];
		}

		if (candidates.length > 1) {
			const sameFolder = candidates.find((file) =>
				file.path.startsWith(`${noteFolder}/`) ||
				file.path === `${noteFolder}/${normalized}`,
			);
			if (sameFolder) {
				return sameFolder;
			}
			return candidates[0];
		}

		if (!shortPath.includes("/")) {
			const nameMatch = this.app.vault
				.getFiles()
				.find((file) => file.name === normalized);
			return nameMatch || null;
		}

		return null;
	}

	private getContentTypeFromName(fileName: string): string {
		const extension = fileName.split(".").pop()?.toLowerCase() || "";
		const map: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			gif: "image/gif",
			webp: "image/webp",
			svg: "image/svg+xml",
			bmp: "image/bmp",
			ico: "image/x-icon",
		};
		return map[extension] || "application/octet-stream";
	}

	private async downloadRemoteFile(url: string): Promise<File> {
		const response = await requestUrl({ url, method: "GET" });
		const arrayBuffer = response.arrayBuffer;
		const contentType =
			(response.headers["content-type"] as string) ||
			(response.headers["Content-Type"] as string) ||
			"application/octet-stream";
		const fileName = this.getFileNameFromUrl(url, contentType);
		return new File([arrayBuffer], fileName, {
			type: contentType,
		});
	}

	private getFileNameFromUrl(url: string, contentType: string): string {
		try {
			const parsed = new URL(url);
			const rawName = parsed.pathname.split("/").pop() || "";
			const name = rawName.split(/[?#]/)[0];
			if (name) {
				return name;
			}
		} catch (error) {
			console.error("Invalid URL when generating file name:", url, error);
		}

		const extension = this.getFileExtension(url, contentType);
		return `downloaded.${extension}`;
	}

	private getFileExtension(url: string, contentType: string): string {
		const urlMatch = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
		if (urlMatch) {
			return urlMatch[1];
		}

		const map: Record<string, string> = {
			"image/jpeg": "jpg",
			"image/png": "png",
			"image/gif": "gif",
			"image/webp": "webp",
			"image/svg+xml": "svg",
			"image/bmp": "bmp",
			"image/x-icon": "ico",
		};
		return map[contentType.toLowerCase()] || "bin";
	}

	private async uploadImageFile(
		file: File,
		noteFile: TFile,
		localUpload: boolean,
	): Promise<string> {
		let buf = await file.arrayBuffer();
		const digest = await generateFileHash(new Uint8Array(buf));
		const extension = file.name.split(".").pop() || this.getFileExtension(file.name, file.type);
		const newFileName = `${digest}.${extension}`;

		const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
		let folder = localUpload
			? fm?.uploadFolder ?? this.settings.localUploadFolder
			: fm?.uploadFolder ?? this.settings.folder;

		const currentDate = new Date();

		folder = folder
			.replace("${year}", currentDate.getFullYear().toString())
			.replace(
				"${month}",
				String(currentDate.getMonth() + 1).padStart(2, "0"),
			)
			.replace(
				"${day}",
				String(currentDate.getDate()).padStart(2, "0"),
			)
			.replace(
				"${basename}",
				noteFile.basename.replace(/ /g, "-"),
			);

		const key = folder ? `${folder}/${newFileName}` : newFileName;

		if (file.type.match(/image.*/) && this.settings.enableImageCompression) {
			buf = await this.compressImage(file);
			file = new File([buf], newFileName, {
				type: file.type,
			});
		}

		if (!localUpload) {
			return await this.uploadFile(file, key);
		} else {
			await this.app.vault.adapter.writeBinary(key, new Uint8Array(buf));
			return this.app.vault.adapter instanceof FileSystemAdapter
				? this.app.vault.adapter.getFilePath(key)
				: key;
		}
	}

	createS3Client(): void {
		// Don't create S3 client if region is not configured
		if (!this.settings.region) {
			return;
		}

		const apiEndpoint = this.settings.useCustomEndpoint
			? this.settings.customEndpoint
			: `https://s3.${this.settings.region}.amazonaws.com/`;
		this.settings.imageUrlPath = this.settings.useCustomImageUrl
			? this.settings.customImageUrl
			: this.settings.forcePathStyle
				? apiEndpoint + this.settings.bucket + "/"
				: apiEndpoint.replace("://", `://${this.settings.bucket}.`);

		if (this.settings.bypassCors) {
			this.s3 = new S3Client({
				region: this.settings.region,
				credentials: {
					// clientConfig: { region: this.settings.region },
					accessKeyId: this.settings.accessKey,
					secretAccessKey: this.settings.secretKey,
				},
				endpoint: apiEndpoint,
				forcePathStyle: this.settings.forcePathStyle,
				requestHandler: new ObsHttpHandler({ keepAlive: false }),
			});
		} else {
			this.s3 = new S3Client({
				region: this.settings.region,
				credentials: {
					// clientConfig: { region: this.settings.region },
					accessKeyId: this.settings.accessKey,
					secretAccessKey: this.settings.secretKey,
				},
				endpoint: apiEndpoint,
				forcePathStyle: this.settings.forcePathStyle,
				requestHandler: new ObsHttpHandler({ keepAlive: false }),
			});
		}
	}

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new S3UploaderSettingTab(this.app, this));

		this.createS3Client();

		this.addCommand({
			id: "upload-image",
			name: "Upload image",
			icon: "image-plus",
			mobileOnly: false,
			editorCallback: (editor) => {
				const input = document.createElement("input");
				input.type = "file";
				input.oninput = (event) => {
					if (!event.target) return;
					this.pasteHandler(event, editor);
				};
				input.click();
				input.remove(); // delete element
			},
		});

		this.addCommand({
			id: "upload-external-image-links",
			name: "Upload external and local image links in current note",
			icon: "cloud-upload",
			mobileOnly: false,
			editorCallback: async (editor) => {
				await this.uploadExternalImagesInCurrentNote(editor);
			},
		});

		this.pasteFunction = (
			event: ClipboardEvent | DragEvent,
			editor: Editor,
		) => {
			this.pasteHandler(event, editor);
		};

		this.registerEvent(
			this.app.workspace.on("editor-paste", this.pasteFunction),
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.pasteFunction),
		);
		// Add mobile-specific event monitoring
		this.registerEvent(
			this.app.vault.on("create", async (file) => {
				// Allow disabling this handler to prevent unwanted uploads from sync/external processes
				if (this.settings.disableAutoUploadOnCreate) return;
				if (!(file instanceof TFile)) return;
				if (!file.path.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return;

				const activeView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView) return;

				// Check if uploads should be ignored for the current file
				if (this.shouldIgnoreCurrentFile()) {
					return; // Don't process the file, let Obsidian handle it normally
				}

				try {
					const fileContent = await this.app.vault.readBinary(file);
					const newFile = new File([fileContent], file.name, {
						type: `image/${file.extension}`,
					});

					// Do the upload
					await this.pasteHandler(null, activeView.editor, newFile);

					// Small delay to ensure editor content is updated
					await new Promise((resolve) => setTimeout(resolve, 50));

					// Now remove the original link if it exists
					const content = activeView.editor.getValue();
					// Check if the "Use [[Wikilinks]]" option is disabled
					const obsidianLink = (this.app.vault as any).getConfig(
						"useMarkdownLinks",
					)
						? `![](${file.name.split(" ").join("%20")})`
						: `![[${file.name}]]`; // Exact pattern we want to find
					const position = content.indexOf(obsidianLink);

					if (position !== -1) {
						const from = activeView.editor.offsetToPos(position);
						const to = activeView.editor.offsetToPos(
							position + obsidianLink.length,
						);
						activeView.editor.replaceRange("", from, to);
					} else {
						new Notice(`Failed to find: ${obsidianLink}`);
					}

					await this.app.vault.delete(file);
				} catch (error) {
					new Notice(`Error processing file: ${error.message}`);
				}
			}),
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class S3UploaderSettingTab extends PluginSettingTab {
	plugin: S3UploaderPlugin;
	// Add properties to store compression setting elements
	private compressionSizeSettings: Setting;
	private compressionQualitySettings: Setting;
	private compressionDimensionSettings: Setting;

	constructor(app: App, plugin: S3UploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Toggle visibility of compression settings
	 * @param show Whether to show the compression settings
	 */
	private toggleCompressionSettings(show: boolean): void {
		if (
			this.compressionSizeSettings &&
			this.compressionQualitySettings &&
			this.compressionDimensionSettings
		) {
			const displayStyle = show ? "" : "none";
			this.compressionSizeSettings.settingEl.style.display = displayStyle;
			this.compressionQualitySettings.settingEl.style.display =
				displayStyle;
			this.compressionDimensionSettings.settingEl.style.display =
				displayStyle;
		}
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Settings for S3 Image Uploader" });

		containerEl.createEl("br");

		const coffeeDiv = containerEl.createDiv("coffee");
		const coffeeLink = coffeeDiv.createEl("a", {
			href: "https://www.buymeacoffee.com/jvsteiner",
		});
		const coffeeImg = coffeeLink.createEl("img", {
			attr: {
				src: "https://cdn.buymeacoffee.com/buttons/v2/default-blue.png",
			},
		});
		coffeeImg.height = 45;
		containerEl.createEl("br");

		new Setting(containerEl)
			.setName("AWS Access Key ID")
			.setDesc("AWS access key ID for a user with S3 access.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("access key")
					.setValue(this.plugin.settings.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.accessKey = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AWS Secret Key")
			.setDesc("AWS secret key for that user.")
			.addText((text) => {
				wrapTextWithPasswordHide(text);
				text.setPlaceholder("secret key")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Region")
			.setDesc("AWS region of the S3 bucket.")
			.addText((text) =>
				text
					.setPlaceholder("aws region")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("S3 Bucket")
			.setDesc("S3 bucket name.")
			.addText((text) =>
				text
					.setPlaceholder("bucket name")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Bucket folder")
			.setDesc(
				"Optional folder in s3 bucket. Support the use of ${year}, ${month}, ${day} and ${basename} variables.",
			)
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Upload on drag")
			.setDesc(
				"Upload drag and drop images as well as pasted images. To override this setting on a per-document basis, you can add `uploadOnDrag: true` to YAML frontmatter of the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadOnDrag)
					.onChange(async (value) => {
						this.plugin.settings.uploadOnDrag = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload video files")
			.setDesc(
				"Upload videos. To override this setting on a per-document basis, you can add `uploadVideo: true` to YAML frontmatter of the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadVideo)
					.onChange(async (value) => {
						this.plugin.settings.uploadVideo = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload audio files")
			.setDesc(
				"Upload audio files. To override this setting on a per-document basis, you can add `uploadAudio: true` to YAML frontmatter of the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadAudio)
					.onChange(async (value) => {
						this.plugin.settings.uploadAudio = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload pdf files")
			.setDesc(
				"Upload and embed PDF files. To override this setting on a per-document basis, you can add `uploadPdf: true` to YAML frontmatter of the note. Local uploads are not supported for PDF files.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadPdf)
					.onChange(async (value) => {
						this.plugin.settings.uploadPdf = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Copy to local folder")
			.setDesc(
				"Copy images to local folder instead of s3. To override this setting on a per-document basis, you can add `localUpload: true` to YAML frontmatter of the note.  This will copy the images to a folder in your local file system, instead of s3.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.localUpload)
					.onChange(async (value) => {
						this.plugin.settings.localUpload = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Upload local note images")
			.setDesc(
				"When enabled, local image references in the current note will also be uploaded or copied when running the upload command.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.uploadLocalNoteImages)
					.onChange(async (value) => {
						this.plugin.settings.uploadLocalNoteImages = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Delete local source images after upload")
			.setDesc(
				"When enabled, local vault image files will be deleted after they are uploaded and replaced in the note.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.deleteLocalImagesAfterUpload)
					.onChange(async (value) => {
						this.plugin.settings.deleteLocalImagesAfterUpload = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Local folder")
			.setDesc(
				'Local folder to save images, instead of s3. To override this setting on a per-document basis, you can add `uploadFolder: "myFolder"` to YAML frontmatter of the note.  This affects only local uploads.',
			)
			.addText((text) =>
				text
					.setPlaceholder("folder")
					.setValue(this.plugin.settings.localUploadFolder)
					.onChange(async (value) => {
						this.plugin.settings.localUploadFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Use custom endpoint")
			.setDesc("Use the custom api endpoint below.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useCustomEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.useCustomEndpoint = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom S3 Endpoint")
			.setDesc(
				"Optionally set a custom endpoint for any S3 compatible storage provider.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://s3.myhost.com/")
					.setValue(this.plugin.settings.customEndpoint)
					.onChange(async (value) => {
						value = value.match(/^https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.customEndpoint = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("S3 Path Style URLs")
			.setDesc(
				"Advanced option to force using (legacy) path-style s3 URLs (s3.myhost.com/bucket) instead of the modern AWS standard host-style (bucket.s3.myhost.com).",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.forcePathStyle)
					.onChange(async (value) => {
						this.plugin.settings.forcePathStyle = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Use custom image URL")
			.setDesc("Use the custom image URL below.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useCustomImageUrl)
					.onChange(async (value) => {
						this.plugin.settings.useCustomImageUrl = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Custom Image URL")
			.setDesc(
				"Advanced option to force inserting custom image URLs. This option is helpful if you are using CDN.",
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.customImageUrl)
					.onChange(async (value) => {
						value = value.match(/^https?:\/\//) // Force to start http(s)://
							? value
							: "https://" + value;
						value = value.replace(/([^/])$/, "$1/"); // Force to end with slash
						this.plugin.settings.customImageUrl = value.trim();
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Bypass local CORS check")
			.setDesc(
				"Bypass local CORS preflight checks - it might work on later versions of Obsidian.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.bypassCors)
					.onChange(async (value) => {
						this.plugin.settings.bypassCors = value;
						this.plugin.createS3Client();
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("Query String Key")
			.setDesc("Appended to the end of the URL. Optional")
			.addText((text) =>
				text
					.setPlaceholder("Empty means no query string key")
					.setValue(this.plugin.settings.queryStringKey)
					.onChange(async (value) => {
						this.plugin.settings.queryStringKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Query String Value")
			.setDesc("Appended to the end of the URL. Optional")
			.addText((text) =>
				text
					.setPlaceholder("Empty means no query string value")
					.setValue(this.plugin.settings.queryStringValue)
					.onChange(async (value) => {
						this.plugin.settings.queryStringValue = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable Image Compression")
			.setDesc("This will reduce the size of images before uploading.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableImageCompression)
					.onChange(async (value) => {
						this.plugin.settings.enableImageCompression = value;
						await this.plugin.saveSettings();

						// Show or hide compression settings based on toggle value
						this.toggleCompressionSettings(value);
					});
			});

		// Always create the compression settings, but control visibility
		this.compressionSizeSettings = new Setting(containerEl)
			.setName("Max Image Size")
			.setDesc(
				"Maximum size of the image after compression in MB. Default is 1MB.",
			)
			.addText((text) =>
				text
					.setPlaceholder("1")
					.setValue(
						this.plugin.settings.maxImageCompressionSize.toString(),
					)
					.onChange(async (value) => {
						// It must be a number, it must be greater than 0
						const newValue = parseFloat(value);
						if (isNaN(newValue) || newValue <= 0) {
							new Notice(
								"Max Image Compression Size must be a number greater than 0",
							);
							return;
						}

						this.plugin.settings.maxImageCompressionSize = newValue;
						await this.plugin.saveSettings();
					}),
			);

		this.compressionQualitySettings = new Setting(containerEl)
			.setName("Image Compression Quality")
			.setDesc(
				"Maximum quality of the image after compression. Default is 0.7.",
			)
			.addSlider((slider) => {
				slider.setDynamicTooltip();
				slider.setLimits(0.0, 1.0, 0.05);
				slider.setValue(this.plugin.settings.imageCompressionQuality);
				slider.onChange(async (value) => {
					this.plugin.settings.imageCompressionQuality = value;
					await this.plugin.saveSettings();
				});
			});

		this.compressionDimensionSettings = new Setting(containerEl)
			.setName("Max Image Width or Height")
			.setDesc(
				"Maximum width or height of the image after compression. Default is 4096px.",
			)
			.addText((text) =>
				text
					.setPlaceholder("4096")
					.setValue(
						this.plugin.settings.maxImageWidthOrHeight.toString(),
					)
					.onChange(async (value) => {
						const parsedValue = parseInt(value);

						if (isNaN(parsedValue) || parsedValue <= 0) {
							new Notice(
								"Max Image Width or Height must be a number greater than 0",
							);
							return;
						}

						this.plugin.settings.maxImageWidthOrHeight =
							parsedValue;
						await this.plugin.saveSettings();
					}),
			);

		// Set initial visibility based on current settings
		this.toggleCompressionSettings(
			this.plugin.settings.enableImageCompression,
		);

		new Setting(containerEl)
			.setName("Disable auto-upload on file create")
			.setDesc(
				"Disable automatic upload when image files are created in the vault (e.g., via sync or external processes). Paste and drag-drop uploads will still work. Enable this if you experience unwanted uploads on startup or when using cloud sync.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.disableAutoUploadOnCreate)
					.onChange(async (value) => {
						this.plugin.settings.disableAutoUploadOnCreate = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Ignore Pattern")
			.setDesc(
				"Glob pattern to ignore files/folders. Use * for any characters, ** for any path, ? for single character. Separate multiple patterns with commas. Example: 'private/*, **/drafts/**, temp*'",
			)
			.addText((text) =>
				text
					.setPlaceholder("private/*, **/drafts/**")
					.setValue(this.plugin.settings.ignorePattern)
					.onChange(async (value) => {
						this.plugin.settings.ignorePattern = value.trim();
						await this.plugin.saveSettings();
					}),
			);
	}
}

const wrapTextWithPasswordHide = (text: TextComponent) => {
	const hider = text.inputEl.insertAdjacentElement(
		"beforebegin",
		createSpan(),
	);
	if (!hider) {
		return;
	}
	setIcon(hider as HTMLElement, "eye-off");

	hider.addEventListener("click", () => {
		const isText = text.inputEl.getAttribute("type") === "text";
		if (isText) {
			setIcon(hider as HTMLElement, "eye-off");
			text.inputEl.setAttribute("type", "password");
		} else {
			setIcon(hider as HTMLElement, "eye");
			text.inputEl.setAttribute("type", "text");
		}
		text.inputEl.focus();
	});
	text.inputEl.setAttribute("type", "password");
	return text;
};

const wrapFileDependingOnType = (
	location: string,
	type: string,
	localBase: string,
) => {
	const srcPrefix = localBase ? "file://" + localBase + "/" : "";

	if (type === "image") {
		return `![image](${location})`;
	} else if (type === "video") {
		return `<video src="${srcPrefix}${location}" controls />`;
	} else if (type === "audio") {
		return `<audio src="${srcPrefix}${location}" controls />`;
	} else if (type === "pdf") {
		if (localBase) {
			throw new Error("PDFs cannot be embedded in local mode");
		}
		return `<iframe frameborder=0 border=0 width=100% height=800
		src="https://docs.google.com/viewer?embedded=true&url=${location}?raw=true">
		</iframe>`;
	} else if (type === "ppt") {
		return `<iframe
	    src='https://view.officeapps.live.com/op/embed.aspx?src=${location}'
	    width='100%' height='600px' frameborder='0'>
	  </iframe>`;
	} else {
		throw new Error("Unknown file type");
	}
};

////////////////////////////////////////////////////////////////////////////////
// special handler using Obsidian requestUrl
////////////////////////////////////////////////////////////////////////////////

/**
 * This is close to origin implementation of FetchHttpHandler
 * https://github.com/aws/aws-sdk-js-v3/blob/main/packages/fetch-http-handler/src/fetch-http-handler.ts
 * that is released under Apache 2 License.
 * But this uses Obsidian requestUrl instead.
 */
class ObsHttpHandler extends FetchHttpHandler {
	requestTimeoutInMs: number | undefined;
	constructor(options?: FetchHttpHandlerOptions) {
		super(options);
		this.requestTimeoutInMs =
			options === undefined ? undefined : options.requestTimeout;
	}
	async handle(
		request: HttpRequest,
		{ abortSignal }: HttpHandlerOptions = {},
	): Promise<{ response: HttpResponse }> {
		if (abortSignal?.aborted) {
			const abortError = new Error("Request aborted");
			abortError.name = "AbortError";
			return Promise.reject(abortError);
		}

		let path = request.path;
		if (request.query) {
			const queryString = buildQueryString(request.query);
			if (queryString) {
				path += `?${queryString}`;
			}
		}

		const { port, method } = request;
		const url = `${request.protocol}//${request.hostname}${
			port ? `:${port}` : ""
		}${path}`;
		const body =
			method === "GET" || method === "HEAD" ? undefined : request.body;

		const transformedHeaders: Record<string, string> = {};
		for (const key of Object.keys(request.headers)) {
			const keyLower = key.toLowerCase();
			if (keyLower === "host" || keyLower === "content-length") {
				continue;
			}
			transformedHeaders[keyLower] = request.headers[key];
		}

		let contentType: string | undefined = undefined;
		if (transformedHeaders["content-type"] !== undefined) {
			contentType = transformedHeaders["content-type"];
		}

		let transformedBody: string | ArrayBuffer | undefined = body;
		if (ArrayBuffer.isView(body)) {
			transformedBody = bufferToArrayBuffer(body);
		}

		const param: RequestUrlParam = {
			body: transformedBody,
			headers: transformedHeaders,
			method: method,
			url: url,
			contentType: contentType,
		};

		const raceOfPromises = [
			requestUrl(param).then((rsp) => {
				const headers = rsp.headers;
				const headersLower: Record<string, string> = {};
				for (const key of Object.keys(headers)) {
					headersLower[key.toLowerCase()] = headers[key];
				}
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(rsp.arrayBuffer));
						controller.close();
					},
				});
				return {
					response: new HttpResponse({
						headers: headersLower,
						statusCode: rsp.status,
						body: stream,
					}),
				};
			}),
			requestTimeout(this.requestTimeoutInMs),
		];

		if (abortSignal) {
			raceOfPromises.push(
				new Promise<never>((resolve, reject) => {
					abortSignal.onabort = () => {
						const abortError = new Error("Request aborted");
						abortError.name = "AbortError";
						reject(abortError);
					};
				}),
			);
		}
		return Promise.race(raceOfPromises);
	}
}

const bufferToArrayBuffer = (b: Buffer | Uint8Array | ArrayBufferView) => {
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

async function generateFileHash(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hashHex.slice(0, 32); // Truncate to same length as MD5 for compatibility
}

/**
 * Check if a file path matches a glob pattern using minimatch
 * Supports standard glob patterns: *, **, ?, etc.
 */
function matchesGlobPattern(filePath: string, pattern: string): boolean {
	if (!pattern || pattern.trim() === "") {
		return false;
	}

	// Split patterns by comma to support multiple patterns
	const patterns = pattern.split(",").map((p) => p.trim());

	return patterns.some((p) => {
		return minimatch(filePath, p);
	});
}
