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
import * as React from 'react';
import 'react-reflex/styles.css';
import { ReflexContainer, ReflexSplitter, ReflexElement, ReflexElementProps } from 'react-reflex';
import { Widget, EXPANSION_TOGGLE_CLASS, COLLAPSED_CLASS, MessageLoop, Message, SplitPanel, BaseWidget, addEventListener, SplitLayout } from './widgets';
import { Event, Emitter } from '../common/event';
import { Disposable, DisposableCollection } from '../common/disposable';
import { MaybePromise } from '../common/types';
import { CommandRegistry } from '../common/command';
import { MenuModelRegistry, MenuPath } from '../common/menu';
import { ContextMenuRenderer, Anchor } from './context-menu-renderer';
import { ApplicationShell } from './shell/application-shell';

// const backgroundColor = () => '#' + (0x1000000 + (Math.random()) * 0xffffff).toString(16).substr(1, 6);

export class ViewContainer extends BaseWidget implements ApplicationShell.TrackableWidgetProvider {

    protected readonly panel: SplitPanel;

    constructor(protected readonly services: ViewContainer.Services, ...props: ViewContainer.Prop[]) {
        super();
        this.id = `view-container-widget-${v4()}`;
        this.addClass('theia-view-container');
        const layout = new SplitLayout({ renderer: SplitPanel.defaultRenderer, spacing: 1, orientation: 'vertical' });
        this.panel = new SplitPanel({ layout });
        this.panel.addClass('split-panel');
        for (const { widget } of props) {
            this.panel.addWidget(new ViewContainerPartWidget2(widget));
        }
    }

    addWidget(prop: ViewContainer.Prop): Disposable {
        // if (this.props.indexOf(prop) !== -1) {
        return Disposable.NULL;
        // }
        // this.props.push(prop);
        // this.container.addWidget(prop.widget);
        // this.update();
        // return Disposable.create(() => this.removeWidget(prop.widget));
    }

    removeWidget(widget: Widget): boolean {
        // const index = this.props.map(p => p.widget).indexOf(widget);
        // if (index === -1) {
        return false;
        // }
        // this.props.splice(index, 1);
        // this.update();
        // return true;
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        [this.panel, ...this.widgets].forEach(widget => MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize));
    }

    protected onUpdateRequest(msg: Message): void {
        [this.panel, ...this.widgets].forEach(widget => widget.update());
        super.onUpdateRequest(msg);
    }

    onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.panel.activate();
    }

    onAfterAttach(msg: Message): void {
        if (this.panel.isAttached) {
            Widget.detach(this.panel);
        }
        Widget.attach(this.panel, this.node);
        super.onAfterAttach(msg);
    }

    getTrackableWidgets(): MaybePromise<Widget[]> {
        return this.widgets;
    }

    /**
     * Sugar for `this.panel.children()`.
     */
    protected get widgets(): Widget[] {
        const widgets: Widget[] = [];
        const itr = this.panel.children();
        let next = itr.next();
        while (next) {
            widgets.push(next);
            next = itr.next();
        }
        return widgets;
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
    export namespace Styles {
        export const VIEW_CONTAINER_CLASS = 'theia-view-container';
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

export class ViewContainerComponent extends React.Component<ViewContainerComponent.Props, ViewContainerComponent.State> {

    protected container: HTMLElement | null;

    constructor(props: Readonly<ViewContainerComponent.Props>) {
        super(props);
        const widgets: Array<{ widget: Widget, hidden?: boolean } & ReflexElementProps> = [];
        const { commandRegistry, menuRegistry } = this.props.services;
        const { contextMenuPath } = this.props;
        for (let i = 0; i < props.widgets.length; i++) {
            const widget = props.widgets[i];
            const { id } = widget;
            const hidden = false;
            widgets.push({
                widget,
                direction: i === 0 ? 1 : i === props.widgets.length - 1 ? -1 : [1, -1],
                minSize: 50,
                hidden // TODO: consider WidgetOptions#hideByDefault
            });
            const commandId = this.toggleVisibilityCommandId(widget);
            commandRegistry.registerCommand({ id: commandId }, {
                execute: () => {
                    const widgetToToggle = this.state.widgets.find(w => w.widget.id === id);
                    if (widgetToToggle) {
                        widgetToToggle.hidden = !widgetToToggle.hidden;
                        this.setState(this.state);
                    }
                },
                isToggled: () => {
                    const widgetToToggle = this.state.widgets.find(w => w.widget.id === id);
                    if (widgetToToggle) {
                        return !widgetToToggle.hidden;
                    }
                    return false;
                }
            });
            menuRegistry.registerMenuAction([...contextMenuPath, '1_widgets'], {
                commandId: commandId,
                label: widget.title.label
            });
        }
        commandRegistry.registerCommand({ id: this.globalHideCommandId }, {
            execute: (anchor: Anchor) => {
                const { x, y } = anchor;
                const element = document.elementFromPoint(x, y);
                if (element instanceof Element) {
                    const part = ViewContainerPart.closestPart(element);
                    if (part && part.id) {
                        const widgetId = part.id.replace(`${this.props.viewContainerId}--`, '');
                        const widgetToToggle = this.state.widgets.find(w => w.widget.id === widgetId);
                        if (widgetToToggle) {
                            widgetToToggle.hidden = true;
                            this.setState(this.state);
                        }
                    }
                }
            },
            isVisible: () => this.state.widgets.some(widget => !widget.hidden)
        });
        menuRegistry.registerMenuAction([...contextMenuPath, '0_global'], {
            commandId: this.globalHideCommandId,
            label: 'Hide'
        });
        this.state = {
            widgets
        };
    }

    protected toggleVisibilityCommandId({ id }: { id: string }): string {
        return `${this.props.viewContainerId}:toggle-visibility-${id}`;
    }

    protected get globalHideCommandId(): string {
        return `${this.props.viewContainerId}:toggle-visibility`;
    }

    componentDidMount(): void {
        if (this.container) {
            const { clientHeight: height, clientWidth: width } = this.container;
            this.setState({
                dimensions: { height, width }
            });
        }
    }

    componentWillUnmount(): void {
        const { commandRegistry, menuRegistry } = this.props.services;
        for (const commandId of [this.globalHideCommandId, ...this.state.widgets.map(({ widget }) => this.toggleVisibilityCommandId(widget))]) {
            commandRegistry.unregisterCommand(commandId);
            menuRegistry.unregisterMenuAction(commandId);
        }
    }

    protected onExpandedChange = (widget: Widget, expanded: boolean) => {
        const { widgets } = this.state;
        const index = widgets.findIndex(part => part.widget.id === widget.id);
        if (index !== -1) {
            widgets[index].minSize = expanded ? 50 : 22;
            this.setState({
                widgets
            });
        }
    }

    protected movedBefore = (movedId: string, beforeId: string) => {
        const movedIndex = this.state.widgets.findIndex(({ widget }) => widget.id === movedId);
        const beforeIndex = this.state.widgets.findIndex(({ widget }) => widget.id === beforeId);
        if (movedIndex !== -1 && beforeIndex !== -1) {
            const { widgets } = this.state;
            const toMove = widgets.splice(movedIndex, 1)[0];
            if (toMove) {
                widgets.splice(beforeIndex, 0, toMove);
                this.setState({
                    widgets
                });
            }
        }
    }

    protected handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
        const { nativeEvent } = event;
        if (nativeEvent.button === 2 /* right */ && !!this.state.dimensions && this.state.widgets.every(widget => !!widget.hidden)) {
            event.stopPropagation();
            event.preventDefault();
            const { services, contextMenuPath } = this.props;
            const { contextMenuRenderer } = services;
            contextMenuRenderer.render(contextMenuPath, event.nativeEvent);
        }
    }

    render(): React.ReactNode {
        const nodes: React.ReactNode[] = [];
        for (let i = 0; i < this.state.widgets.length; i++) {
            const { widget } = this.state.widgets[i];
            const { id } = widget;
            if (!this.state.widgets[i].hidden) {
                if (nodes.length !== 0) {
                    nodes.push(<ReflexSplitter key={`splitter-${id}`} propagate={true} />);
                }
                nodes.push(<ViewContainerPart
                    key={id}
                    widget={widget}
                    viewContainerId={this.props.viewContainerId}
                    {...this.state.widgets[i]}
                    onExpandedChange={this.onExpandedChange}
                    movedBefore={this.movedBefore}
                    contextMenuRenderer={this.props.services.contextMenuRenderer}
                    contextMenuPath={this.props.contextMenuPath}
                />);
            }
        }
        return <div
            className={ViewContainerComponent.Styles.ROOT}
            ref={(element => this.container = element)}
            onContextMenu={this.handleContextMenu}>
            {this.state.dimensions ? <ReflexContainer orientation='horizontal'>{nodes}</ReflexContainer> : ''}
        </div>;
    }

}
export namespace ViewContainerComponent {
    export interface Props {
        viewContainerId: string;
        contextMenuPath: MenuPath;
        widgets: Widget[];
        services: ViewContainer.Services;
    }
    export interface State {
        dimensions?: { height: number, width: number }
        widgets: Array<{ widget: Widget, hidden?: boolean } & ReflexElementProps>
    }
    export namespace Styles {
        export const ROOT = 'root';
    }
}

export class ViewContainerPartWidget2 extends BaseWidget {

    protected readonly header: HTMLElement;
    protected readonly body: HTMLElement;
    protected readonly collapsedEmitter = new Emitter<boolean>();

    protected collapsed: boolean;

    constructor(protected widget: Widget, { collapsed }: { collapsed: boolean } = { collapsed: false }) {
        super();
        this.addClass('part');
        this.collapsed = collapsed;
        const { header, body, disposable } = this.createContent();
        this.header = header;
        this.body = body;
        this.toDispose.pushAll([
            this.collapsedEmitter,
            disposable
        ]);
        this.scrollOptions = {
            suppressScrollX: true,
            minScrollbarLength: 35
        };
        this.node.tabIndex = 0;
    }

    get onCollapsed(): Event<boolean> {
        return this.collapsedEmitter.event;
    }

    getScrollContainer(): HTMLElement {
        return this.node;
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
            this.collapsed = !this.collapsed;
            // TODO: do we really need this? Cannot we hide the `widget`? Can we pass in container instead?
            this.collapsedEmitter.fire(this.collapsed);
            this.body.style.display = this.collapsed ? 'none' : 'block';
            // tslint:disable-next-line:no-shadowed-variable
            const toggleIcon = this.header.querySelector(`span.${EXPANSION_TOGGLE_CLASS}`);
            if (toggleIcon) {
                toggleIcon.classList.toggle(COLLAPSED_CLASS);
            }
            this.update();
        }));

        const toggleIcon = document.createElement('span');
        toggleIcon.classList.add(EXPANSION_TOGGLE_CLASS);
        if (this.collapsed) {
            toggleIcon.classList.add(COLLAPSED_CLASS);
        }
        header.appendChild(toggleIcon);

        const title = document.createElement('span');
        title.classList.add('label', 'noselect');
        title.innerText = this.widget.title.label;
        header.appendChild(title);

        if (ViewContainerPartWidget.is(this.widget)) {
            for (const { tooltip, execute, className } of this.widget.toolbarElements.filter(e => e.enabled !== false)) {
                const toolbarItem = document.createElement('span');
                toolbarItem.classList.add('element');
                if (className) {
                    // XXX: `className` should be `MaybeArray<string>` instead.
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
        MessageLoop.sendMessage(this.widget, Widget.Msg.BeforeAttach);
        if (this.widget.isAttached) {
            Widget.detach(this.widget);
        }
        Widget.attach(this.widget, this.body);
        MessageLoop.sendMessage(this.widget, Widget.Msg.AfterAttach);
        this.update();
        super.onAfterAttach(msg);
    }

    onUpdateRequest(msg: Message): void {
        if (this.widget.isAttached) {
            this.widget.update();
        }
        super.onUpdateRequest(msg);
    }

}

export class ViewContainerPart extends React.Component<ViewContainerPart.Props, ViewContainerPart.State> {

    constructor(props: ViewContainerPart.Props) {
        super(props);
        this.state = {
            expanded: true,
            size: -1
        };
    }

    protected detaching = false;
    componentWillUnmount(): void {
        const { widget } = this.props;
        if (widget.isAttached) {
            this.detaching = true;
            MessageLoop.sendMessage(widget, Widget.Msg.BeforeDetach);
        }
    }

    protected onDragStart = (e: React.DragEvent<HTMLDivElement>, widget: Widget) => {
        const { dataTransfer } = e;
        if (dataTransfer) {
            dataTransfer.effectAllowed = 'move';
            const dragImage = document.createElement('div');
            dragImage.classList.add('theia-drag-image');
            dragImage.textContent = widget.title.label;
            document.body.appendChild(dragImage);
            dataTransfer.setDragImage(dragImage, -10, -10);
            dataTransfer.setData('view-container-dnd', widget.id);
            setTimeout(() => document.body.removeChild(dragImage), 0);
        }
    }

    protected onDragOver = (e: React.DragEvent<HTMLDivElement>, widget: Widget) => {
        e.preventDefault();
        const reflexElement = ViewContainerPart.closestPart(e.target);
        if (reflexElement instanceof HTMLElement) {
            reflexElement.classList.add(ViewContainerPart.Styles.DROP_TARGET);
        }
    }

    protected onDrop = (e: React.DragEvent<HTMLDivElement>, widget: Widget) => {
        const moveId = e.dataTransfer.getData('view-container-dnd');
        if (moveId && moveId !== widget.id) {
            this.props.movedBefore(moveId, widget.id);
        }
        e.preventDefault();
        const part = ViewContainerPart.closestPart(e.target);
        if (part instanceof HTMLElement) {
            part.classList.remove(ViewContainerPart.Styles.DROP_TARGET);
        }
    }

    protected onDragLeave = (e: React.DragEvent<HTMLDivElement>, widget: Widget) => {
        e.preventDefault();
        const part = ViewContainerPart.closestPart(e.target);
        if (part instanceof HTMLElement) {
            part.classList.remove(ViewContainerPart.Styles.DROP_TARGET);
        }
    }

    render(): React.ReactNode {
        const { widget } = this.props;
        const toggleClassNames = [EXPANSION_TOGGLE_CLASS];
        if (!this.state.expanded) {
            toggleClassNames.push(COLLAPSED_CLASS);
        }
        const toggleClassName = toggleClassNames.join(' ');
        const reflexProps = Object.assign({ ...this.props }, { minSize: this.state.expanded ? 50 : 22 });
        return <ReflexElement
            propagateDimensions={true}
            size={this.state.expanded ? this.state.size : 0}
            {...reflexProps}>
            <div id={`${this.props.viewContainerId}--${widget.id}`}
                className={ViewContainerPart.Styles.PART}
                onDragOver={e => this.onDragOver(e, widget)}
                onDragLeave={e => this.onDragLeave(e, widget)}
                onDrop={e => this.onDrop(e, widget)}>
                <div className={`theia-header ${ViewContainerPart.Styles.HEADER}`}
                    title={widget.title.caption}
                    onClick={this.toggle}
                    onContextMenu={this.handleContextMenu}
                    draggable
                    onDragStart={e => this.onDragStart(e, widget)}>
                    <span className={toggleClassName} />
                    <span className={`${ViewContainerPart.Styles.LABEL} noselect`}>{widget.title.label}</span>
                    {this.state.expanded && this.renderToolbar()}
                </div>
                {this.state.expanded && <div className={ViewContainerPart.Styles.BODY} ref={this.setRef}
                />}
            </div>
        </ReflexElement>;
    }

    protected renderToolbar(): React.ReactNode {
        const { widget } = this.props;
        if (!ViewContainerPartWidget.is(widget)) {
            return undefined;
        }
        return <React.Fragment>
            {widget.toolbarElements.map((element, key) => this.renderToolbarElement(key, element))}
        </React.Fragment>;
    }

    protected renderToolbarElement(key: number, element: ViewContainerPartToolbarElement): React.ReactNode {
        if (element.enabled === false) {
            return undefined;
        }
        const { className, tooltip, execute } = element;
        const classNames = [ViewContainerPart.Styles.ELEMENT];
        if (className) {
            classNames.push(className);
        }
        return <span key={key}
            title={tooltip}
            className={classNames.join(' ')}
            onClick={async e => {
                e.stopPropagation();
                e.preventDefault();
                await execute();
                this.forceUpdate();
            }} />;
    }

    protected handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
        const { nativeEvent } = event;
        // Secondary button pressed, usually the right button.
        if (nativeEvent.button === 2 /* right */) {
            event.stopPropagation();
            event.preventDefault();
            const { contextMenuRenderer, contextMenuPath } = this.props;
            contextMenuRenderer.render(contextMenuPath, event.nativeEvent);
        }
    }

    protected toggle = () => {
        if (this.state.expanded) {
            Widget.detach(this.props.widget);
        }
        const expanded = !this.state.expanded;
        this.setState({
            expanded
        });
        if (this.props.onExpandedChange) {
            this.props.onExpandedChange(this.props.widget, expanded);
        }
    }

    protected ref: HTMLElement | undefined;
    protected setRef = (ref: HTMLElement | null) => {
        const { widget } = this.props;
        if (ref) {
            MessageLoop.sendMessage(widget, Widget.Msg.BeforeAttach);
            // tslint:disable:no-null-keyword
            ref.insertBefore(widget.node, null);
            MessageLoop.sendMessage(widget, Widget.Msg.AfterAttach);
            widget.update();
        } else if (this.detaching) {
            this.detaching = false;
            MessageLoop.sendMessage(widget, Widget.Msg.AfterDetach);
        }
    }

}

export namespace ViewContainerPart {

    export interface Props extends ReflexElementProps {
        readonly viewContainerId: string;
        readonly contextMenuRenderer: ContextMenuRenderer;
        readonly contextMenuPath: MenuPath;
        readonly widget: Widget;
        onExpandedChange(widget: Widget, expanded: boolean): void;
        /**
         * `movedId` the ID of the widget to insert before the widget with `beforeId`.
         */
        movedBefore(movedId: string, beforeId: string): void;
    }

    export interface State {
        expanded: boolean;
        size: number;
    }

    export namespace Styles {
        export const PART = 'part';
        export const HEADER = 'header';
        export const LABEL = 'label';
        export const ELEMENT = 'element';
        export const BODY = 'body';
        export const DROP_TARGET = 'drop-target';
    }

    export function closestPart(element: Element | EventTarget, selector: string = `div.${ViewContainerPart.Styles.PART}`): Element | undefined {
        if (element instanceof Element) {
            const part = element.closest(selector);
            if (part instanceof Element) {
                return part;
            }
        }
        return undefined;
    }
}

// const SortableViewContainerPart = SortableElement(ViewContainerPart);

export interface ViewContainerPartToolbarElement {
    /** default true */
    readonly enabled?: boolean
    readonly className: string
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
