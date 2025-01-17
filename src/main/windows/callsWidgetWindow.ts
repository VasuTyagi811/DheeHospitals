// Copyright (c) 2016-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {IpcMainEvent, Rectangle, Event, IpcMainInvokeEvent} from 'electron';
import {BrowserWindow, desktopCapturer, ipcMain, systemPreferences} from 'electron';

import ServerViewState from 'app/serverViewState';
import {
    BROWSER_HISTORY_PUSH,
    CALLS_ERROR,
    CALLS_JOIN_CALL,
    CALLS_JOIN_REQUEST,
    CALLS_JOINED_CALL,
    CALLS_LEAVE_CALL,
    CALLS_LINK_CLICK,
    CALLS_POPOUT_FOCUS,
    CALLS_WIDGET_CHANNEL_LINK_CLICK,
    CALLS_WIDGET_RESIZE,
    CALLS_WIDGET_SHARE_SCREEN,
    CALLS_WIDGET_OPEN_THREAD,
    CALLS_WIDGET_OPEN_STOP_RECORDING_MODAL,
    DESKTOP_SOURCES_MODAL_REQUEST,
    GET_DESKTOP_SOURCES,
    UPDATE_SHORTCUT_MENU,
} from 'common/communication';
import {Logger} from 'common/log';
import {CALLS_PLUGIN_ID, MINIMUM_CALLS_WIDGET_HEIGHT, MINIMUM_CALLS_WIDGET_WIDTH} from 'common/utils/constants';
import {getFormattedPathName, isCallsPopOutURL, parseURL} from 'common/utils/url';
import Utils from 'common/utils/util';
import PermissionsManager from 'main/permissionsManager';
import {
    composeUserAgent,
    getLocalPreload,
    openScreensharePermissionsSettingsMacOS,
    resetScreensharePermissionsMacOS,
} from 'main/utils';
import type {MattermostBrowserView} from 'main/views/MattermostBrowserView';
import ViewManager from 'main/views/viewManager';
import webContentsEventManager from 'main/views/webContentEvents';
import MainWindow from 'main/windows/mainWindow';

import type {
    CallsJoinCallMessage,
    CallsWidgetWindowConfig,
} from 'types/calls';

import ContextMenu from '../contextMenu';

const log = new Logger('CallsWidgetWindow');

export class CallsWidgetWindow {
    private win?: BrowserWindow;
    private mainView?: MattermostBrowserView;
    private options?: CallsWidgetWindowConfig;
    private missingScreensharePermissions?: boolean;

    private popOut?: BrowserWindow;
    private boundsErr: Rectangle = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
    };

    constructor() {
        ipcMain.on(CALLS_WIDGET_RESIZE, this.handleResize);
        ipcMain.on(CALLS_WIDGET_SHARE_SCREEN, this.handleShareScreen);
        ipcMain.on(CALLS_POPOUT_FOCUS, this.handlePopOutFocus);
        ipcMain.handle(GET_DESKTOP_SOURCES, this.handleGetDesktopSources);
        ipcMain.handle(CALLS_JOIN_CALL, this.handleCreateCallsWidgetWindow);
        ipcMain.on(CALLS_LEAVE_CALL, this.handleCallsLeave);

        // forwards to the main app
        ipcMain.on(DESKTOP_SOURCES_MODAL_REQUEST, this.forwardToMainApp(DESKTOP_SOURCES_MODAL_REQUEST));
        ipcMain.on(CALLS_ERROR, this.forwardToMainApp(CALLS_ERROR));
        ipcMain.on(CALLS_LINK_CLICK, this.handleCallsLinkClick);
        ipcMain.on(CALLS_JOIN_REQUEST, this.forwardToMainApp(CALLS_JOIN_REQUEST));
        ipcMain.on(CALLS_WIDGET_OPEN_THREAD, this.handleCallsOpenThread);
        ipcMain.on(CALLS_WIDGET_OPEN_STOP_RECORDING_MODAL, this.handleCallsOpenStopRecordingModal);

        // deprecated in favour of CALLS_LINK_CLICK
        ipcMain.on(CALLS_WIDGET_CHANNEL_LINK_CLICK, this.handleCallsWidgetChannelLinkClick);
    }

    /**
     * Getters
     */

    get callID() {
        return this.options?.callID;
    }

    private get serverID() {
        return this.mainView?.view.server.id;
    }

    public isOpen() {
        return Boolean(this.win && !this.win.isDestroyed());
    }

    /**
     * Helper functions
     */

    public openDevTools = () => {
        this.win?.webContents.openDevTools({mode: 'detach'});
    };

    getViewURL = () => {
        return this.mainView?.view.server.url;
    };

    isCallsWidget = (webContentsId: number) => {
        return webContentsId === this.win?.webContents.id || webContentsId === this.popOut?.webContents.id;
    };

    private getWidgetURL = () => {
        if (!this.mainView) {
            return undefined;
        }
        const u = parseURL(this.mainView.view.server.url.toString()) as URL;

        u.pathname = getFormattedPathName(u.pathname);
        u.pathname += `plugins/${CALLS_PLUGIN_ID}/standalone/widget.html`;

        if (this.options?.callID) {
            u.searchParams.append('call_id', this.options.callID);
        }
        if (this.options?.title) {
            u.searchParams.append('title', this.options.title);
        }
        if (this.options?.rootID) {
            u.searchParams.append('root_id', this.options.rootID);
        }

        return u.toString();
    };

    private init = (view: MattermostBrowserView, options: CallsWidgetWindowConfig) => {
        this.win = new BrowserWindow({
            width: MINIMUM_CALLS_WIDGET_WIDTH,
            height: MINIMUM_CALLS_WIDGET_HEIGHT,
            title: 'Calls Widget',
            fullscreen: false,
            resizable: false,
            frame: false,
            transparent: true,
            show: false,
            alwaysOnTop: true,
            hasShadow: false,
            backgroundColor: '#00ffffff',
            webPreferences: {
                preload: getLocalPreload('externalAPI.js'),
            },
        });
        this.mainView = view;
        this.options = options;

        this.win.once('ready-to-show', () => this.win?.show());
        this.win.once('show', this.onShow);
        this.win.on('closed', this.onClosed);

        this.win.webContents.setWindowOpenHandler(this.onPopOutOpen);
        this.win.webContents.on('did-create-window', this.onPopOutCreate);

        // Calls widget window is not supposed to navigate anywhere else.
        this.win.webContents.on('will-navigate', this.onNavigate);
        this.win.webContents.on('did-start-navigation', this.onNavigate);

        const widgetURL = this.getWidgetURL();
        if (!widgetURL) {
            return;
        }
        this.win?.loadURL(widgetURL, {
            userAgent: composeUserAgent(),
        }).catch((reason) => {
            log.error(`failed to load: ${reason}`);
        });
    };

    private close = async () => {
        log.debug('close');
        if (!this.win) {
            return Promise.resolve();
        }
        if (this.win.isDestroyed()) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            if (!this.win) {
                resolve();
                return;
            }
            this.win?.on('closed', resolve);
            this.win?.close();
        });
    };

    private setBounds(bounds: Rectangle) {
        if (!this.win) {
            return;
        }

        // NOTE: this hack is needed to fix positioning on certain systems where
        // BrowserWindow.setBounds() is not consistent.
        bounds.x += this.boundsErr.x;
        bounds.y += this.boundsErr.y;
        bounds.height += this.boundsErr.height;
        bounds.width += this.boundsErr.width;

        this.win.setBounds(bounds);
        this.boundsErr = Utils.boundsDiff(bounds, this.win.getBounds());
    }

    /**
     * BrowserWindow/WebContents handlers
     */

    private onClosed = () => {
        ipcMain.emit(UPDATE_SHORTCUT_MENU);
        delete this.win;
        delete this.mainView;
        delete this.options;
    };

    private onNavigate = (ev: Event, url: string) => {
        if (url === this.getWidgetURL()) {
            return;
        }
        log.warn(`prevented widget window from navigating to: ${url}`);
        ev.preventDefault();
    };

    private onShow = () => {
        log.debug('onShow');
        const mainWindow = MainWindow.get();
        if (!(this.win && mainWindow)) {
            return;
        }

        this.win.focus();
        this.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
        this.win.setAlwaysOnTop(true, 'screen-saver');

        const bounds = this.win.getBounds();
        const mainBounds = mainWindow.getBounds();
        const initialBounds = {
            x: mainBounds.x + 12,
            y: (mainBounds.y + mainBounds.height) - bounds.height - 12,
            width: MINIMUM_CALLS_WIDGET_WIDTH,
            height: MINIMUM_CALLS_WIDGET_HEIGHT,
        };
        this.win.setMenuBarVisibility(false);

        if (process.env.MM_DEBUG_CALLS_WIDGET) {
            this.openDevTools();
        }

        ipcMain.emit(UPDATE_SHORTCUT_MENU);

        this.setBounds(initialBounds);
    };

    private onPopOutOpen = ({url}: { url: string }) => {
        if (!(this.mainView && this.options)) {
            return {action: 'deny' as const};
        }

        const parsedURL = parseURL(url);
        if (!parsedURL) {
            return {action: 'deny' as const};
        }
        if (isCallsPopOutURL(this.mainView?.view.server.url, parsedURL, this.options?.callID)) {
            return {
                action: 'allow' as const,
                overrideBrowserWindowOptions: {
                    autoHideMenuBar: true,
                },
            };
        }

        log.warn(`onPopOutOpen: prevented window open to ${url}`);
        return {action: 'deny' as const};
    };

    private onPopOutCreate = (win: BrowserWindow) => {
        this.popOut = win;

        // Let the webContentsEventManager handle links that try to open a new window.
        webContentsEventManager.addWebContentsEventListeners(this.popOut.webContents);

        // Need to capture and handle redirects for security.
        this.popOut.webContents.on('will-redirect', (event: Event) => {
            // There's no reason we would allow a redirect from the call's popout. Eventually we may, so revise then.
            // Note for the future: the code from https://github.com/mattermost/desktop/pull/2580 will not work for us.
            event.preventDefault();
        });

        const contextMenu = new ContextMenu({}, this.popOut);
        contextMenu.reload();

        this.popOut.on('closed', () => {
            delete this.popOut;
            contextMenu.dispose();
        });

        // Set the userAgent so that the widget's popout is considered a desktop window in the webapp code.
        // 'did-frame-finish-load' is the earliest moment that allows us to call loadURL without throwing an error.
        // https://mattermost.atlassian.net/browse/MM-52756 is the proper fix for this.
        this.popOut.webContents.once('did-frame-finish-load', async () => {
            const url = this.popOut?.webContents.getURL() || '';
            if (!url) {
                return;
            }

            try {
                await this.popOut?.loadURL(url, {
                    userAgent: composeUserAgent(),
                });
            } catch (e) {
                log.error('did-frame-finish-load, failed to reload with correct userAgent', e);
            }
        });
    };

    /************************
     * IPC HANDLERS
     ************************/

    private handleResize = (ev: IpcMainEvent, width: number, height: number) => {
        log.debug('handleResize', width, height);

        if (!this.win) {
            return;
        }

        if (!this.isCallsWidget(ev.sender.id)) {
            log.debug('handleResize', 'Disallowed calls event');
            return;
        }

        const zoomFactor = this.win.webContents.getZoomFactor();
        const currBounds = this.win.getBounds();
        const newBounds = {
            x: currBounds.x,
            y: currBounds.y - (Math.ceil(height * zoomFactor) - currBounds.height),
            width: Math.ceil(width * zoomFactor),
            height: Math.ceil(height * zoomFactor),
        };

        this.setBounds(newBounds);
    };

    private handleShareScreen = (ev: IpcMainEvent, sourceID: string, withAudio: boolean) => {
        log.debug('handleShareScreen', {sourceID, withAudio});

        if (this.mainView?.webContentsId !== ev.sender.id) {
            log.debug('handleShareScreen', 'blocked on wrong webContentsId');
            return;
        }

        this.win?.webContents.send(CALLS_WIDGET_SHARE_SCREEN, sourceID, withAudio);
    };

    private handlePopOutFocus = () => {
        if (!this.popOut) {
            return;
        }
        if (this.popOut.isMinimized()) {
            this.popOut.restore();
        }
        this.popOut.focus();
    };

    private handleGetDesktopSources = async (event: IpcMainInvokeEvent, opts: Electron.SourcesOptions) => {
        log.debug('handleGetDesktopSources', opts);

        if (event.sender.id !== this.mainView?.webContentsId) {
            log.warn('handleGetDesktopSources', 'Blocked on wrong webContentsId');
            return [];
        }

        const view = ViewManager.getViewByWebContentsId(event.sender.id);
        if (!view) {
            log.error('handleGetDesktopSources: view not found');
            return [];
        }

        if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
            try {
                // If permissions are missing we reset them so that the system
                // prompt can be showed.
                await resetScreensharePermissionsMacOS();

                // We only open the system settings if permissions were already missing since
                // on the first attempt to get the sources the OS will correctly show a prompt.
                if (this.missingScreensharePermissions) {
                    await openScreensharePermissionsSettingsMacOS();
                }
                this.missingScreensharePermissions = true;
            } catch (err) {
                log.error('failed to reset screen sharing permissions', err);
            }
        }

        if (!await PermissionsManager.doPermissionRequest(view.webContentsId, 'screenShare', {requestingUrl: view.view.server.url.toString(), isMainFrame: false})) {
            log.warn('screen share permissions disallowed', view.webContentsId, view.view.server.url.toString());
            return [];
        }

        const screenPermissionsErrArgs = ['screen-permissions', this.callID];

        return desktopCapturer.getSources(opts).then((sources) => {
            let hasScreenPermissions = true;
            if (systemPreferences.getMediaAccessStatus) {
                const screenPermissions = systemPreferences.getMediaAccessStatus('screen');
                log.debug('screenPermissions', screenPermissions);
                if (screenPermissions === 'denied') {
                    log.info('no screen sharing permissions');
                    hasScreenPermissions = false;
                }
            }

            if (!hasScreenPermissions || !sources.length) {
                log.info('missing screen permissions');
                view.sendToRenderer(CALLS_ERROR, ...screenPermissionsErrArgs);
                this.win?.webContents.send(CALLS_ERROR, ...screenPermissionsErrArgs);
                return [];
            }

            const message = sources.map((source) => {
                return {
                    id: source.id,
                    name: source.name,
                    thumbnailURL: source.thumbnail.toDataURL(),
                };
            });

            return message;
        }).catch((err) => {
            log.error('desktopCapturer.getSources failed', err);

            view.sendToRenderer(CALLS_ERROR, ...screenPermissionsErrArgs);
            this.win?.webContents.send(CALLS_ERROR, ...screenPermissionsErrArgs);

            return [];
        });
    };

    private handleCreateCallsWidgetWindow = async (event: IpcMainInvokeEvent, msg: CallsJoinCallMessage) => {
        log.debug('createCallsWidgetWindow');

        // trying to join again the call we are already in should not be allowed.
        if (this.options?.callID === msg.callID) {
            return Promise.resolve();
        }

        // to switch from one call to another we need to wait for the existing
        // window to be fully closed.
        await this.close();

        const currentView = ViewManager.getViewByWebContentsId(event.sender.id);
        if (!currentView) {
            log.error('unable to create calls widget window: currentView is missing');
            return Promise.resolve();
        }

        const promise = new Promise((resolve) => {
            const connected = (ev: IpcMainEvent, incomingCallId: string, incomingSessionId: string) => {
                log.debug('onJoinedCall', incomingCallId);

                if (!this.isCallsWidget(ev.sender.id)) {
                    log.debug('onJoinedCall', 'blocked on wrong webContentsId');
                    return;
                }

                if (msg.callID !== incomingCallId) {
                    log.debug('onJoinedCall', 'blocked on wrong callId');
                    return;
                }

                ipcMain.off(CALLS_JOINED_CALL, connected);
                resolve({callID: msg.callID, sessionID: incomingSessionId});
            };
            ipcMain.on(CALLS_JOINED_CALL, connected);
        });

        this.init(currentView, {
            callID: msg.callID,
            title: msg.title,
            rootID: msg.rootID,
            channelURL: msg.channelURL,
        });

        return promise;
    };

    private handleCallsLeave = () => {
        log.debug('handleCallsLeave');

        this.close();
    };

    private forwardToMainApp = (channel: string) => {
        return (event: IpcMainEvent, ...args: any) => {
            log.debug('forwardToMainApp', channel, ...args);

            if (!this.isCallsWidget(event.sender.id)) {
                return;
            }

            if (!this.serverID) {
                return;
            }

            ServerViewState.switchServer(this.serverID);
            MainWindow.get()?.focus();
            this.mainView?.sendToRenderer(channel, ...args);
        };
    };

    private handleCallsOpenThread = (event: IpcMainEvent, threadID: string) => {
        this.forwardToMainApp(CALLS_WIDGET_OPEN_THREAD)(event, threadID);
    };

    private handleCallsOpenStopRecordingModal = (event: IpcMainEvent, channelID: string) => {
        this.forwardToMainApp(CALLS_WIDGET_OPEN_STOP_RECORDING_MODAL)(event, channelID);
    };

    private handleCallsLinkClick = (event: IpcMainEvent, url: string) => {
        log.debug('handleCallsLinkClick', url);

        if (!this.isCallsWidget(event.sender.id)) {
            return;
        }

        if (!this.serverID) {
            return;
        }

        const parsedURL = parseURL(url);
        if (parsedURL) {
            ViewManager.handleDeepLink(parsedURL);
            return;
        }

        // If parsing above fails it means it's a relative path (e.g.
        // pointing to a channel).

        ServerViewState.switchServer(this.serverID);
        MainWindow.get()?.focus();
        this.mainView?.sendToRenderer(BROWSER_HISTORY_PUSH, url);
    };

    /**
     * @deprecated
     */
    private handleCallsWidgetChannelLinkClick = (event: IpcMainEvent) => {
        log.debug('handleCallsWidgetChannelLinkClick');

        if (!this.isCallsWidget(event.sender.id)) {
            return;
        }

        if (!this.serverID) {
            return;
        }

        ServerViewState.switchServer(this.serverID);
        MainWindow.get()?.focus();
        this.mainView?.sendToRenderer(BROWSER_HISTORY_PUSH, this.options?.channelURL);
    };
}

const callsWidgetWindow = new CallsWidgetWindow();
export default callsWidgetWindow;
