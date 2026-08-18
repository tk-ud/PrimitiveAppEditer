```yaml
tool:
  name: "roadmap"
  version: "1.0"

  authority:
    roadmap: "./roadmap.yaml"
    specification_references: "selected_bundle.reference"

  rules:
    - "roadmap.yaml is the progress authority"
    - "Each selected bundle reference in roadmap.yaml is the specification input authority"
    - "App Editer.md remains the Architecture / Authority / Boundary SSOT"
    - "Detail SSOTs supplement and must not redefine App Editer.md authority"
    - "Agent must not infer or add specification sources that are absent from selected_bundle.reference"
    - "Implementation-role references define selected bundle implementation scope"
    - "Boundary-role references constrain implementation and never add implementation scope"
    - "Agent must not modify roadmap.yaml directly"
    - "Roadmap mutation must be performed only by roadmap.complete"
    - "depends_on is defined only by roadmap.yaml"
    - "implemented bundles must never be selected again"
    - "partial bundles remain selectable"
    - "A bundle is selectable only when all depends_on bundles are implemented"

  commands:

    next:
      description: >
        Resolve the next executable roadmap bundle and construct
        the implementation prompt for the agent.

      input:
        type: object
        properties: {}
        additional_properties: false

      sequence:
        - id: load_roadmap
          action: "read_yaml"
          source: "./roadmap.yaml"

        - id: collect_candidates
          action: "filter"
          condition:
            status:
              not_equals: "implemented"

        - id: resolve_dependencies
          action: "filter"
          condition:
            depends_on:
              all_status: "implemented"

        - id: select_bundle
          action: "select_first"
          order:
            - "section order"
            - "bundle order"

        - id: specifications
          action: "map"
          collection_from: "selected_bundle.reference"
          preserve_order: true
          item:
            action: "read_markdown_sections"
            source_from: "item.source"
            role_from: "item.role"
            sections_from: "item.sections"
            preserve_source: true
            preserve_role: true

        - id: validate_specification_set
          action: "detect_reference_conflict"
          input_from: "specifications"
          on_conflict:
            status: "blocked"
            stop_condition: "A reference conflict prevents a deterministic implementation decision."
            output:
              message: "Referenced specifications conflict; implementation was not started."

        - id: implementation_specifications
          action: "filter"
          collection_from: "specifications"
          condition:
            role:
              equals: "implementation"

        - id: boundary_constraints
          action: "filter"
          collection_from: "specifications"
          condition:
            role:
              equals: "boundary"

        - id: render_prompt
          action: "template"
          template: |
            Implement the following roadmap bundle.

            ## Bundle
            id: {{ bundle.id }}
            title: {{ bundle.title }}
            status: {{ bundle.status }}

            ## Dependencies
            {{ bundle.depends_on }}

            ## Current Evidence
            {{ bundle.evidence }}

            ## Remaining Work
            {{ bundle.remaining }}

            ## Implementation Specification
            {{#each implementation_specifications}}
            ### {{ source }}
            {{ content }}

            {{/each}}

            ## Boundary Constraints
            {{#each boundary_constraints}}
            ### {{ source }}
            {{ content }}

            {{/each}}

            ## Execution Rules
            - Implement only the selected bundle's implementation specifications.
            - Treat boundary references as constraints, not additional implementation scope.
            - Do not implement adjacent UI / Resolver / Runtime work merely because a boundary reference mentions it.
            - Keep all implementation consistent with supplied boundary constraints.
            - Preserve the Authority / Detail SSOT boundary identified by each source.
            - Do not infer requirements from specification files not supplied here.
            - If implementation or boundary references conflict, stop without implementing and report the conflict.
            - Do not modify roadmap.yaml directly.
            - Do not redefine depends_on.
            - Preserve existing implementation outside this bundle.
            - Verify the implementation before reporting completion.
            - When work is finished, call roadmap.complete.
            - Use status "implemented" only when the bundle is complete and verified.
            - Use status "partial" when work remains.
            - Record concrete evidence.
            - Record remaining work when status is "partial".

      output:
        type: object
        required:
          - id
          - prompt
          - specifications

        properties:
          id:
            type: string

          prompt:
            type: string

          bundle:
            type: object
            properties:
              id:
                type: string
              title:
                type: string
              status:
                enum:
                  - "not started"
                  - "partial"
              depends_on:
                type: array
                items:
                  type: string
              reference:
                type: array
                items:
                  type: object
                  required:
                    - source
                    - role
                    - sections
                  properties:
                    source:
                      type: string
                    role:
                      type: string
                      enum:
                        - "implementation"
                        - "boundary"
                    sections:
                      type: array
                      items:
                        type: string

          specifications:
            type: array
            items:
              type: object
              required:
                - source
                - role
                - content
              properties:
                source:
                  type: string
                role:
                  type: string
                  enum:
                    - "implementation"
                    - "boundary"
                sections:
                  type: array
                  items:
                    type: string
                content:
                  type: string

      no_candidate:
        status: "completed"
        output:
          message: "All executable roadmap bundles are implemented."

      blocked:
        status: "blocked"
        output:
          message: >
            Unimplemented roadmap bundles exist, but none currently
            satisfy their dependencies.


    complete:
      description: >
        Validate and persist progress for one roadmap bundle.

      input:
        type: object

        required:
          - id
          - status
          - evidence
          - remaining

        additional_properties: false

        properties:

          id:
            type: string
            description: "Bundle id defined in roadmap.yaml"

          status:
            type: string
            enum:
              - "partial"
              - "implemented"

          evidence:
            type: array
            items:
              type: string
            description: >
              Concrete implementation and verification evidence.
              Prefer files, tests, commands, behavior, or commit references.

          remaining:
            type: array
            items:
              type: string
            description: >
              Explicit unfinished work.
              Must be empty when status is implemented.

      validation:

        - rule: "bundle_exists"
          field: "id"

        - rule: "current_status_is_not_implemented"

        - rule: "depends_on_unchanged"

        - rule: "dependencies_are_implemented"

        - rule: "evidence_not_empty"

        - rule: "implemented_requires_empty_remaining"
          when:
            status: "implemented"

        - rule: "partial_requires_non_empty_remaining"
          when:
            status: "partial"

        - rule: "status_transition"
          allowed:
            "not started":
              - "partial"
              - "implemented"

            "partial":
              - "partial"
              - "implemented"

            "implemented":
              - "implemented"

      sequence:

        - id: load_roadmap
          action: "read_yaml"
          source: "./roadmap.yaml"

        - id: resolve_bundle
          action: "find_bundle"
          key: "id"

        - id: validate
          action: "validate_input"

        - id: update_status
          action: "set"
          target: "bundle.status"
          value_from: "input.status"

        - id: update_evidence
          action: "set"
          target: "bundle.evidence"
          value_from: "input.evidence"

        - id: update_remaining
          action: "set"
          target: "bundle.remaining"
          value_from: "input.remaining"

        - id: save
          action: "atomic_write_yaml"
          target: "./roadmap.yaml"

      output:
        type: object

        required:
          - id
          - status
          - next_action

        properties:

          id:
            type: string

          status:
            enum:
              - "partial"
              - "implemented"

          next_action:
            enum:
              - "restart"
              - "completed"
              - "blocked"

          message:
            type: string


  lifecycle:

    startup:
      - "call roadmap.next"
      - "receive generated prompt"
      - "execute implementation"

    completion:
      - "call roadmap.complete"
      - "persist progress"
      - "exit"

    next_run:
      - "call roadmap.next again"
```
