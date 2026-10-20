/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - Activity Bar, Side Bar, Editor Tabs and Bottom Panel (workbench.views)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (39. Structure, Editor Tabs, Side Bar, Bottom Panel)
 *  docs/primitive-app-editor/Editor UI.md (3. Workbench Placement, 9, 10, 14)
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions } from '../../../common/editor.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../common/views.js';
import { IPrimitiveAppEditorService } from '../common/primitiveAppEditorService.js';
import {
	ActivityBarItem, projectReadyContextKey, activityBarContainerId, activityBarIcon, activityBarItems, activityBarTitle, activityBarViewId,
	bottomPanelContainerId, BottomPanelView, bottomPanelTitle, bottomPanelViewId, bottomPanelViews,
} from '../common/workbenchViews.js';
import { PrimitiveAppEditorPane } from './primitiveAppEditorEditor.js';
import { PrimitiveAppEditorInput } from './primitiveAppEditorEditorInput.js';
import { PrimitiveAppEditorService } from './primitiveAppEditorService.js';
import { PrimitiveAppEditorInspectorView, PrimitiveAppEditorPanelView, PrimitiveAppEditorSideBarView } from './primitiveAppEditorViews.js';

registerSingleton(IPrimitiveAppEditorService, PrimitiveAppEditorService, InstantiationType.Delayed);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

// #region Activity Bar + Primary Side Bar: one View Container (Activity Bar entry) and one View per item

activityBarItems.forEach((item: ActivityBarItem, index) => {
	const containerId = activityBarContainerId(item);
	const icon = ThemeIcon.fromId(activityBarIcon(item));
	const container = viewContainersRegistry.registerViewContainer({
		id: containerId,
		title: { value: activityBarTitle(item), original: activityBarTitle(item) },
		icon,
		order: 100 + index,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: `${containerId}.state`,
		hideIfEmpty: false,
		windowEnablement: WindowEnablement.Editor,
	}, ViewContainerLocation.Sidebar);

	const view: IViewDescriptor = {
		id: activityBarViewId(item),
		name: { value: activityBarTitle(item), original: activityBarTitle(item) },
		containerIcon: icon,
		ctorDescriptor: new SyncDescriptor(PrimitiveAppEditorSideBarView, [item]),
		canToggleVisibility: false,
		canMoveView: false,
		windowEnablement: WindowEnablement.Editor,
	};
	viewsRegistry.registerViews([view], container);
});

// #endregion

// #region Secondary Side Bar: Registry Driven Inspector

const inspectorContainerId = 'workbench.view.primitiveAppEditor.inspector';
const inspectorViewId = 'primitiveAppEditor.view.inspector';
const inspectorIcon = ThemeIcon.fromId('symbol-property');
const inspectorTitle = localize('primitiveAppEditor.inspector.title', "Inspector");

const inspectorContainer = viewContainersRegistry.registerViewContainer({
	id: inspectorContainerId,
	title: { value: inspectorTitle, original: 'Inspector' },
	icon: inspectorIcon,
	order: 100,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [inspectorContainerId, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: `${inspectorContainerId}.state`,
	hideIfEmpty: true,
	windowEnablement: WindowEnablement.Editor,
}, ViewContainerLocation.AuxiliaryBar);

viewsRegistry.registerViews([{
	id: inspectorViewId,
	name: { value: inspectorTitle, original: 'Inspector' },
	containerIcon: inspectorIcon,
	ctorDescriptor: new SyncDescriptor(PrimitiveAppEditorInspectorView),
	when: projectReadyContextKey,
	canToggleVisibility: false,
	canMoveView: false,
	windowEnablement: WindowEnablement.Editor,
}], inspectorContainer);

// #endregion

// #region Bottom Panel: Console / Build Log / Runtime State / Event Log / Function Output / Diagnostics

const panelTitle = localize('primitiveAppEditor.panel.title', "App Editor");
const panelContainer = viewContainersRegistry.registerViewContainer({
	id: bottomPanelContainerId(),
	title: { value: panelTitle, original: 'App Editor' },
	icon: ThemeIcon.fromId('output'),
	order: 100,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [bottomPanelContainerId(), { mergeViewWithContainerWhenSingleView: false }]),
	storageId: `${bottomPanelContainerId()}.state`,
	hideIfEmpty: false,
	windowEnablement: WindowEnablement.Editor,
}, ViewContainerLocation.Panel);

viewsRegistry.registerViews(bottomPanelViews.map((panelView: BottomPanelView, index): IViewDescriptor => ({
	id: bottomPanelViewId(panelView),
	name: { value: bottomPanelTitle(panelView), original: bottomPanelTitle(panelView) },
	containerIcon: ThemeIcon.fromId('output'),
	ctorDescriptor: new SyncDescriptor(PrimitiveAppEditorPanelView, [panelView]),
	canToggleVisibility: true,
	canMoveView: false,
	order: index,
	windowEnablement: WindowEnablement.Editor,
})), panelContainer);

// #endregion

// #region Editor Area: Editor Tabs

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(PrimitiveAppEditorPane, PrimitiveAppEditorPane.ID, localize('primitiveAppEditor.editor.name', "App Editor")),
	[new SyncDescriptor(PrimitiveAppEditorInput)]
);

// #endregion
