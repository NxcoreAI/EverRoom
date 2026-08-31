# Everroom Frontend Guidelines

## Visual Source Of Truth

- For Everroom PC parity work, treat the `nexcore-pc` component source and its computed runtime styles as the source of truth. Port the component structure first, then add the smallest CE-specific route or data adapter.
- Do not redraw an existing PC interface from screenshots when its source is available. Screenshots are for verification, not implementation.
- Do not migrate Qiankun, window-context integration, the Agent bridge, or the real cloud-document host into CE. Preserve the PC visual shell with local CE adapters instead.
- Use `lucide-react` for interface icons because both projects already use it. Keep a single icon family and use `strokeWidth={1.8}` for product-surface icons.

## Component Architecture

- Pages orchestrate state and routing. They should not contain large reusable views or long repeated markup blocks.
- Put feature code under a feature directory, for example `components/context-room/`, with separate files for configuration, shared primitives, page views, panels, dialogs, and data adapters.
- Extract a component when it is reused, owns state, has a distinct layout responsibility, or makes its parent difficult to scan.
- Prefer typed configuration arrays for navigation items, tabs, actions, and semantic icon tones.
- Keep IPC and data access in page or feature controllers. Presentational components receive typed props and emit callbacks.
- Avoid files above roughly 300 lines. If a file grows beyond that size, split it by responsibility before adding more behavior.
- Avoid duplicate markup and duplicated color literals. Shared controls and semantic values belong in reusable components or tokens.

## Styling

- Global theme values live in `styles/tokens.css`. Components consume variables instead of redefining brand colors.
- Use one blue brand accent and neutral work surfaces. Semantic icon colors may use the PC tone map for documents, rooms, memory, tasks, communication, people, calendar, and data.
- Keep product radii in the 4px to 8px range. Use shadows only for overlays or meaningful elevation.
- Keep desktop information density high: 29px navigation rows, 32px to 36px controls, compact headers, and edge-to-edge work surfaces.
- Feature styles must be scoped to the feature root. Do not add unrelated feature selectors to the global stylesheet.
- Support 1280x720 and 1024x768 without horizontal page overflow. Preserve keyboard focus and reduced-motion behavior.
