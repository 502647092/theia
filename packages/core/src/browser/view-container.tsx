/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { interfaces } from 'inversify';
import { v4 } from 'uuid';
import { Widget, EXPANSION_TOGGLE_CLASS, COLLAPSED_CLASS, MessageLoop, Message, SplitPanel, BaseWidget, addEventListener, SplitLayout } from './widgets';
import { Event, Emitter } from '../common/event';
import { Disposable, DisposableCollection } from '../common/disposable';
import { MaybePromise } from '../common/types';
import { CommandRegistry } from '../common/command';
import { MenuModelRegistry, MenuPath } from '../common/menu';
import { ContextMenuRenderer, Anchor } from './context-menu-renderer';
import { ApplicationShell } from './shell/application-shell';
import { TheiaSplitLayout } from './shell/theia-split-layout';

export class ViewContainer extends BaseWidget implements ApplicationShell.TrackableWidgetProvider {

    readonly panel: SplitPanel;
    readonly partHeight = new Map<ViewContainerPart, number>();

    constructor(protected readonly services: ViewContainer.Services, ...props: ViewContainer.Prop[]) {
        super();
        this.id = `view-container-widget-${v4()}`;
        this.addClass('theia-view-container');
        const layout = new TheiaSplitLayout({ renderer: SplitPanel.defaultRenderer, spacing: 2, orientation: this.orientation });
        this.panel = new SplitPanel({ layout });
        this.panel.addClass('split-panel');
        for (const { widget } of props) {
            this.addWidget(widget);
        }

        const { commandRegistry, menuRegistry, contextMenuRenderer } = this.services;
        commandRegistry.registerCommand({ id: this.globalHideCommandId }, {
            execute: (anchor: Anchor) => {
                const { x, y } = anchor;
                const element = document.elementFromPoint(x, y);
                if (element instanceof Element) {
                    const closestPart = ViewContainerPart.closestPart(element);
                    if (closestPart && closestPart.id) {
                        const toHide = this.parts.find(part => part.id === closestPart.id);
                        if (toHide) {
                            this.toggleVisibility(toHide);
                        }
                    }
                }
            },
            isVisible: () => this.parts.some(part => !part.isHidden)
        });
        menuRegistry.registerMenuAction([...this.contextMenuPath, '0_global'], {
            commandId: this.globalHideCommandId,
            label: 'Hide'
        });
        this.toDispose.pushAll([
            addEventListener(this.node, 'contextmenu', event => {
                if (event.button === 2 && this.parts.every(part => !!part.isHidden)) {
                    event.stopPropagation();
                    event.preventDefault();
                    contextMenuRenderer.render(this.contextMenuPath, event);
                }
            }),
            Disposable.create(() => commandRegistry.unregisterCommand(this.globalHideCommandId)),
            Disposable.create(() => menuRegistry.unregisterMenuAction(this.globalHideCommandId)),
            Disposable.create(() => this.partHeight.clear())
        ]);
    }

    addWidget(widget: Widget, options?: ViewContainer.Factory.WidgetOptions): Disposable {
        const widgets = this.parts.map(part => part.wrapped);
        if (widgets.indexOf(widget) !== -1) {
            return Disposable.NULL;
        }
        const newPart = new ViewContainerPart(widget, this.id, { collapsed: false }); // TODO: `collapsed`.
        this.registerPart(newPart);
        this.layout.addWidget(newPart);
        // this.update();
        return new DisposableCollection(
            Disposable.create(() => this.removeWidget(widget)),
            newPart.onCollapsed(() => this.toggleCollapsed(newPart)),
            newPart.onMoveBefore(toMoveId => this.moveBefore(toMoveId, newPart.id)),
            newPart.onContextMenu(event => {
                if (event.button === 2) {
                    event.preventDefault();
                    event.stopPropagation();
                    const { contextMenuRenderer } = this.services;
                    contextMenuRenderer.render(this.contextMenuPath, event);
                }
            })
        );
    }

    removeWidget(widget: Widget): boolean {
        const part = this.parts.find(({ wrapped }) => wrapped.id === widget.id);
        if (!part) {
            return false;
        }
        this.unregisterPart(part);
        this.layout.removeWidget(part);
        // this.update();
        return true;
    }

    getTrackableWidgets(): MaybePromise<Widget[]> {
        return this.parts;
    }

    public get layout(): TheiaSplitLayout {
        return this.panel.layout as TheiaSplitLayout;
    }

    protected registerPart(toRegister: ViewContainerPart): void {
        const { commandRegistry, menuRegistry } = this.services;
        const commandId = this.toggleVisibilityCommandId(toRegister);
        commandRegistry.registerCommand({ id: commandId }, {
            execute: () => {
                const toHide = this.parts.find(part => part.id === toRegister.id);
                if (toHide) {
                    this.toggleVisibility(toHide);
                }
            },
            isToggled: () => {
                const widgetToToggle = this.parts.find(part => part.id === toRegister.id);
                if (widgetToToggle) {
                    return !widgetToToggle.isHidden;
                }
                return false;
            }
        });
        menuRegistry.registerMenuAction([...this.contextMenuPath, '1_widgets'], {
            commandId: commandId,
            label: toRegister.wrapped.title.label
            // order: TODO: the order should be based on the part order.
        });
    }

    protected unregisterPart(part: ViewContainerPart): void {
        const { commandRegistry, menuRegistry } = this.services;
        const commandId = this.toggleVisibilityCommandId(part);
        commandRegistry.unregisterCommand(commandId);
        menuRegistry.unregisterMenuAction(commandId);
        this.partHeight.delete(part);
    }

    protected toggleVisibility(part: ViewContainerPart): void {
        part.setHidden(!part.isHidden);
    }

    protected toggleCollapsed(part: ViewContainerPart): void {
        const index = this.parts.indexOf(part);
        if (index === -1) {
            return;
        }

        if (part.collapsed) {

            // Store the height before we collapse it.
            this.partHeight.set(part, part.node.clientHeight);

            let beforeOpenIndex = -1;
            for (let i = index - 1; i >= 0; i--) {
                if (!this.parts[i].collapsed) {
                    beforeOpenIndex = i;
                    break;
                }
            }

            // If there is a preceding open handler we stretch that one.
            if (beforeOpenIndex !== -1) {
                const handlePosition = index === this.parts.length - 1 ? this.panel.node.offsetHeight : this.layout.handles[index].offsetTop;
                const position = handlePosition - this.layout.handles[index].offsetHeight - ViewContainerPart.HEADER_HEIGHT;
                this.layout.moveHandle(beforeOpenIndex, position);
            } else {
                // Otherwise, we push the current one down.
                const position = index === 0 ? ViewContainerPart.HEADER_HEIGHT : this.layout.handles[index - 1].offsetHeight + ViewContainerPart.HEADER_HEIGHT;
                this.layout.moveHandle(index, position);
            }

            const openedParts = this.parts.filter(p => !p.collapsed);
            if (openedParts.length === 0) {
                // Collapse all and move all handlers up to the top.
                for (let i = 0; i < this.parts.length; i++) {
                    const position = ViewContainerPart.HEADER_HEIGHT + this.panel.handles[i].offsetHeight;
                    this.layout.moveHandle(i, position);
                }
            } else if (openedParts.length === 1) {
                // Collapse all and the stretch the space for the single open part.
                const toStretchIndex = this.parts.indexOf(openedParts[0]);
                if (toStretchIndex !== -1) {
                    if (toStretchIndex === 0) {
                        const position = this.panel.node.offsetHeight - ((this.parts.length - 1) * ViewContainerPart.HEADER_HEIGHT);
                        this.layout.moveHandle(toStretchIndex, position);
                    } else if (toStretchIndex === this.parts.length - 1) {
                        const position = (this.parts.length - 1) * ViewContainerPart.HEADER_HEIGHT;
                        this.layout.moveHandle(toStretchIndex - 1, position);
                    } else {
                        const position = toStretchIndex * ViewContainerPart.HEADER_HEIGHT;
                        this.layout.moveHandle(toStretchIndex - 1, position);
                    }
                }
            }
        } else {
            const height = this.partHeight.get(part);
            this.partHeight.delete(part);
            if (height === undefined) {
                console.log(`${part.id} does not have a previous height.`);
            } else {
                if (index === 0) {
                    this.layout.moveHandle(index, height);
                } else if (index === this.parts.length - 1) {
                    this.layout.moveHandle(index - 1, this.panel.node.offsetHeight - this.layout.handles[index - 1].clientHeight - height);
                } else {
                    // TODO: !!!
                    if (this.parts[index - 1].collapsed) {
                        this.layout.moveHandle(index, this.layout.handles[index].offsetTop + height);
                    } else {
                        this.layout.moveHandle(index - 1, this.layout.handles[index - 1].offsetTop - height);
                    }
                }
            }
        }
    }

    protected moveBefore(toMovedId: string, moveBeforeThisId: string): void {
        const toMoveIndex = this.parts.findIndex(part => part.id === toMovedId);
        const moveBeforeThisIndex = this.parts.findIndex(part => part.id === moveBeforeThisId);
        if (toMoveIndex !== -1 && moveBeforeThisIndex !== -1) {
            this.layout.moveWidget(toMoveIndex, moveBeforeThisIndex);
        }
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        for (const widget of [this.panel, ...this.parts]) {
            MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize);
        }
        super.onResize(msg);
    }

    protected onUpdateRequest(msg: Message): void {
        for (const widget of [this.panel, ...this.parts]) {
            widget.update();
        }
        const handles = () => this.panel.handles.map((h, i) => `${i} [collapsed: ${this.parts[i].collapsed}]: ${h.offsetTop}`);
        console.log('after update: handles', handles());
        super.onUpdateRequest(msg);
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.panel.activate();
    }

    protected onAfterAttach(msg: Message): void {
        if (this.panel.isAttached) {
            Widget.detach(this.panel);
        }
        this.layout.orientation = this.orientation;
        Widget.attach(this.panel, this.node);
        super.onAfterAttach(msg);
    }

    protected get orientation(): SplitLayout.Orientation {
        if (this.node.closest('#theia-main-content-panel') || this.node.closest('#theia-bottom-content-panel')) {
            return 'horizontal';
        }
        return 'vertical';
    }

    /**
     * Sugar for `this.layout.iter()`. Returns with the parts, **not** the `wrapped`, original widgets.
     */
    protected get parts(): ViewContainerPart[] {
        const parts: ViewContainerPart[] = [];
        const itr = this.layout.iter();
        let next = itr.next();
        while (next) {
            if (next instanceof ViewContainerPart) {
                parts.push(next);
            } else {
                throw new Error(`Expected an instance of ${ViewContainerPart.prototype}. Got ${JSON.stringify(next)} instead.`);
            }
            next = itr.next();
        }
        return parts;
    }

    protected get contextMenuPath(): MenuPath {
        return [`${this.id}-context-menu`];
    }

    protected toggleVisibilityCommandId(part: ViewContainerPart): string {
        return `${this.id}:toggle-visibility-${part.id}`;
    }

    protected get globalHideCommandId(): string {
        return `${this.id}:toggle-visibility`;
    }

}

export namespace ViewContainer {

    export interface Prop {
        readonly widget: Widget;
        readonly options?: ViewContainer.Factory.WidgetOptions;
    }

    export interface Services {
        readonly contextMenuRenderer: ContextMenuRenderer;
        readonly commandRegistry: CommandRegistry;
        readonly menuRegistry: MenuModelRegistry;
    }

    export const Factory = Symbol('ViewContainerFactory');
    export interface Factory {
        (...widgets: Factory.WidgetDescriptor[]): ViewContainer;
    }
    export namespace Factory {
        export interface WidgetOptions {

            /**
             * https://code.visualstudio.com/docs/getstarted/keybindings#_when-clause-contexts
             */
            readonly when?: string;

            readonly order?: number;

            readonly weight?: number;

            readonly collapsed?: boolean;

            readonly canToggleVisibility?: boolean;

            // Applies only to newly created views
            readonly hideByDefault?: boolean;

            readonly workspace?: boolean;

            readonly focusCommand?: { id: string, keybindings?: string };
        }
        export interface WidgetDescriptor {

            // tslint:disable-next-line:no-any
            readonly widget: Widget | interfaces.ServiceIdentifier<Widget>;

            readonly options?: WidgetOptions;
        }
    }
}

export class ViewContainerPart extends BaseWidget {

    /**
     * Make sure to adjust the `line-height` of the `.theia-view-container .part .header` CSS class when modifying this, and vice versa.
     */
    static HEADER_HEIGHT = 22;

    protected readonly header: HTMLElement;
    protected readonly body: HTMLElement;
    protected readonly collapsedEmitter = new Emitter<boolean>();
    protected readonly moveBeforeEmitter = new Emitter<string>();
    protected readonly contextMenuEmitter = new Emitter<MouseEvent>();

    protected _collapsed: boolean;
    /**
     * Self cannot be a drop target. When the drag event starts, we disable the current part as a possible drop target.
     *
     * This is a workaround for not being able to sniff into the `event.dataTransfer.getData` value when `dragover` due to security reasons.
     */
    protected canBeDropTarget = true;

    constructor(
        public readonly wrapped: Widget,
        protected readonly viewContainerId: string,
        { collapsed }: { collapsed: boolean } = { collapsed: false }) {

        super();
        this.id = `${this.viewContainerId}--${wrapped.id}`;
        this.addClass('part');
        this._collapsed = collapsed;
        const { header, body, disposable } = this.createContent();
        this.header = header;
        this.body = body;
        this.toDispose.pushAll([
            disposable,
            this.collapsedEmitter,
            this.moveBeforeEmitter,
            this.contextMenuEmitter,
            this.registerDND(),
            this.registerContextMenu()
        ]);
        this.scrollOptions = {
            suppressScrollX: true,
            minScrollbarLength: 35 // TODO: Adjust this?
        };
        this.node.tabIndex = 0;
        if (collapsed) {
            this.collapsedEmitter.fire(collapsed);
        }
    }

    get collapsed(): boolean {
        return this._collapsed;
    }

    get onCollapsed(): Event<boolean> {
        return this.collapsedEmitter.event;
    }

    get onMoveBefore(): Event<string> {
        return this.moveBeforeEmitter.event;
    }

    get onContextMenu(): Event<MouseEvent> {
        return this.contextMenuEmitter.event;
    }

    protected getScrollContainer(): HTMLElement {
        return this.body;
    }

    protected registerContextMenu(): Disposable {
        return new DisposableCollection(
            addEventListener(this.header, 'contextmenu', event => {
                this.contextMenuEmitter.fire(event);
            }),
            addEventListener(this.body, 'contextmenu', event => {
                // Just disabled the native menu.
                if (event.button === 2) {
                    // TODO: do now show the native context menu if the `body` is empty.
                    // const { x, y } = event;
                    // const element = document.elementFromPoint(x, y);
                    // event.stopPropagation();
                    // event.preventDefault();
                }
            })
        );
    }

    protected registerDND(): Disposable {
        this.header.draggable = true;
        const style = (event: DragEvent) => {
            event.preventDefault();
            const part = ViewContainerPart.closestPart(event.target);
            if (part instanceof HTMLElement) {
                if (this.canBeDropTarget) {
                    part.classList.add('drop-target');
                }
            }
        };
        const unstyle = (event: DragEvent) => {
            event.preventDefault();
            const part = ViewContainerPart.closestPart(event.target);
            if (part instanceof HTMLElement) {
                part.classList.remove('drop-target');
            }
        };
        return new DisposableCollection(
            addEventListener(this.header, 'dragstart', event => {
                const { dataTransfer } = event;
                if (dataTransfer) {
                    this.canBeDropTarget = false;
                    dataTransfer.effectAllowed = 'move';
                    dataTransfer.setData('view-container-dnd', this.id);
                    const dragImage = document.createElement('div');
                    dragImage.classList.add('theia-drag-image');
                    dragImage.innerText = this.wrapped.title.label;
                    document.body.appendChild(dragImage);
                    dataTransfer.setDragImage(dragImage, -10, -10);
                    setTimeout(() => document.body.removeChild(dragImage), 0);
                }
            }, false),
            addEventListener(this.node, 'dragend', () => this.canBeDropTarget = true, false),
            addEventListener(this.node, 'dragover', style, false),
            addEventListener(this.node, 'dragleave', unstyle, false),
            addEventListener(this.node, 'drop', event => {
                const { dataTransfer } = event;
                if (dataTransfer) {
                    const moveId = dataTransfer.getData('view-container-dnd');
                    if (moveId && moveId !== this.id) {
                        this.moveBeforeEmitter.fire(moveId);
                    }
                    unstyle(event);
                }
            }, false)
        );
    }

    protected createContent(): { header: HTMLElement, body: HTMLElement, disposable: Disposable } {
        const disposable = new DisposableCollection();
        const { header, disposable: headerDisposable } = this.createHeader();
        const body = document.createElement('div');
        body.classList.add('body');
        this.node.appendChild(header);
        this.node.appendChild(body);
        disposable.push(headerDisposable);
        return {
            header,
            body,
            disposable,
        };
    }

    protected createHeader(): { header: HTMLElement, disposable: Disposable } {
        const disposable = new DisposableCollection();
        const header = document.createElement('div');
        header.classList.add('theia-header', 'header');
        disposable.push(addEventListener(header, 'click', () => {
            this._collapsed = !this._collapsed;
            this.body.style.display = this._collapsed ? 'none' : 'block';
            // tslint:disable-next-line:no-shadowed-variable
            const toggleIcon = this.header.querySelector(`span.${EXPANSION_TOGGLE_CLASS}`);
            if (toggleIcon) {
                toggleIcon.classList.toggle(COLLAPSED_CLASS);
            }
            this.update();
            this.collapsedEmitter.fire(this._collapsed);
        }));

        const toggleIcon = document.createElement('span');
        toggleIcon.classList.add(EXPANSION_TOGGLE_CLASS);
        if (this._collapsed) {
            toggleIcon.classList.add(COLLAPSED_CLASS);
        }
        header.appendChild(toggleIcon);

        const title = document.createElement('span');
        title.classList.add('label', 'noselect');
        title.innerText = this.wrapped.title.label;
        header.appendChild(title);

        if (ViewContainerPartWidget.is(this.wrapped)) {
            for (const { tooltip, execute, className } of this.wrapped.toolbarElements.filter(e => e.enabled !== false)) {
                const toolbarItem = document.createElement('span');
                toolbarItem.classList.add('element');
                if (className) {
                    // TODO: `className` should be `MaybeArray<string>` or `string | string[]` instead.
                    toolbarItem.classList.add(...className.split(' '));
                }
                toolbarItem.title = tooltip;
                disposable.push(addEventListener(toolbarItem, 'click', async event => {
                    event.stopPropagation();
                    event.preventDefault();
                    await execute();
                    this.update();
                }));
                header.appendChild(toolbarItem);
            }
        }
        return {
            header,
            disposable
        };
    }

    onAfterAttach(msg: Message): void {
        MessageLoop.sendMessage(this.wrapped, Widget.Msg.BeforeAttach);
        if (this.wrapped.isAttached) {
            Widget.detach(this.wrapped);
        }
        Widget.attach(this.wrapped, this.body);
        MessageLoop.sendMessage(this.wrapped, Widget.Msg.AfterAttach);
        this.update();
        super.onAfterAttach(msg);
    }

    onUpdateRequest(msg: Message): void {
        if (this.wrapped.isAttached) {
            this.wrapped.update();
        }
        super.onUpdateRequest(msg);
    }

}

export namespace ViewContainerPart {

    export function closestPart(element: Element | EventTarget | null, selector: string = 'div.part'): Element | undefined {
        if (element instanceof Element) {
            const part = element.closest(selector);
            if (part instanceof Element) {
                return part;
            }
        }
        return undefined;
    }
}

export interface ViewContainerPartToolbarElement {
    /** default true */
    readonly enabled?: boolean
    readonly className: string // TODO: `string | string[]`
    readonly tooltip: string
    // tslint:disable-next-line:no-any
    execute(): any
}

export interface ViewContainerPartWidget extends Widget {
    readonly toolbarElements: ViewContainerPartToolbarElement[];
}

export namespace ViewContainerPartWidget {
    export function is(widget: Widget | undefined): widget is ViewContainerPartWidget {
        return !!widget && ('toolbarElements' in widget);
    }
}
