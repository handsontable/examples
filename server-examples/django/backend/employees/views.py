import json

from django.db import transaction
from django.db.models import Q
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.response import Response

from .models import Employee
from .pagination import EmployeePagination
from .serializers import EmployeeSerializer

# Only allow ordering on known fields to prevent ORM injection.
ALLOWED_ORDERING_FIELDS = {'first_name', 'last_name', 'department', 'role', 'salary'}

# Numeric fields must use exact (not iexact) to avoid casting errors on DecimalField.
NUMERIC_FIELDS = {'salary'}

# Maps Handsontable Filters condition names to Django ORM lookup suffixes.
# eq/not_eq intentionally omitted — resolved dynamically based on field type below.
_CONDITION_LOOKUP = {
    'contains':     ('icontains', False),
    'not_contains': ('icontains', True),
    'begins_with':  ('istartswith', False),
    'ends_with':    ('iendswith', False),
    'gte':          ('gte', False),
    'lte':          ('lte', False),
    'gt':           ('gt', False),
    'lt':           ('lt', False),
}


class EmployeeViewSet(viewsets.ModelViewSet):
    queryset = Employee.objects.all()
    serializer_class = EmployeeSerializer
    pagination_class = EmployeePagination
    filter_backends = [OrderingFilter, SearchFilter]
    ordering_fields = list(ALLOWED_ORDERING_FIELDS)
    search_fields = ['first_name', 'last_name', 'department', 'role']

    def get_queryset(self):
        queryset = Employee.objects.all()

        # --- Sort ---
        # Handsontable sends sort[prop] + sort[order]; translate to Django ordering.
        sort_prop  = self.request.query_params.get('sort[prop]')
        sort_order = self.request.query_params.get('sort[order]', 'asc')

        if sort_prop and sort_prop in ALLOWED_ORDERING_FIELDS:
            prefix = '' if sort_order == 'asc' else '-'
            queryset = queryset.order_by(f'{prefix}{sort_prop}')

        # --- Filters ---
        # dataProvider passes filters as a JSON array of DataProviderFilterColumn objects:
        # [{ prop, operation, conditions: [{ name, args }] }, ...]
        # Each column's conditions combine with AND (conjunction) or OR (disjunction).
        filters_json = self.request.query_params.get('filters')
        if filters_json:
            try:
                filter_cols = json.loads(filters_json)
                q = Q()
                for col in filter_cols:
                    prop      = col.get('prop', '')
                    operation = col.get('operation', 'conjunction')
                    conditions = col.get('conditions') or []

                    # Whitelist prop to known fields.
                    if prop not in ALLOWED_ORDERING_FIELDS:
                        continue

                    col_q_parts = []
                    for cond in conditions:
                        name = cond.get('name')
                        args = cond.get('args') or []
                        value = args[0] if args else None

                        is_numeric = prop in NUMERIC_FIELDS

                        if name == 'empty':
                            # DecimalField rejects __exact='' — use isnull only for numeric fields.
                            if is_numeric:
                                col_q_parts.append(Q(**{f'{prop}__isnull': True}))
                            else:
                                col_q_parts.append(Q(**{f'{prop}__exact': ''}) | Q(**{f'{prop}__isnull': True}))
                            continue
                        if name == 'not_empty':
                            if is_numeric:
                                col_q_parts.append(Q(**{f'{prop}__isnull': False}))
                            else:
                                col_q_parts.append(~Q(**{f'{prop}__exact': ''}) & ~Q(**{f'{prop}__isnull': True}))
                            continue

                        # eq/not_eq: use exact for numeric fields, iexact for text fields.
                        if name in ('eq', 'not_eq'):
                            lookup = f'{prop}__exact' if is_numeric else f'{prop}__iexact'
                            cond_q = Q(**{lookup: value})
                            col_q_parts.append(~cond_q if name == 'not_eq' else cond_q)
                            continue

                        if name not in _CONDITION_LOOKUP or value is None:
                            continue

                        lookup_suffix, negate = _CONDITION_LOOKUP[name]
                        lookup = f'{prop}__{lookup_suffix}'
                        cond_q = Q(**{lookup: value})
                        col_q_parts.append(~cond_q if negate else cond_q)

                    if not col_q_parts:
                        continue

                    # Combine conditions within this column.
                    if operation == 'disjunction':
                        col_q = col_q_parts[0]
                        for part in col_q_parts[1:]:
                            col_q |= part
                    else:
                        col_q = col_q_parts[0]
                        for part in col_q_parts[1:]:
                            col_q &= part

                    q &= col_q

                queryset = queryset.filter(q)
            except (json.JSONDecodeError, TypeError, KeyError):
                pass

        return queryset

    # --- Batch CRUD endpoints ---
    # dataProvider sends all mutations as arrays in a single request.

    @action(detail=False, methods=['post'], url_path='create-rows')
    @transaction.atomic
    def create_rows(self, request):
        rows_amount = max(1, int(request.data.get('rowsAmount', 1)))
        employees = Employee.objects.bulk_create([
            Employee(first_name='', last_name='', department='', role='', salary=0)
            for _ in range(rows_amount)
        ])
        serializer = EmployeeSerializer(employees, many=True)
        return Response(serializer.data, status=201)

    @action(detail=False, methods=['patch'], url_path='update-rows')
    @transaction.atomic
    def update_rows(self, request):
        updated = []
        for row in request.data:
            employee = Employee.objects.get(pk=row['id'])
            serializer = EmployeeSerializer(employee, data=row['changes'], partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save()
            updated.append(serializer.data)
        return Response(updated)

    @action(detail=False, methods=['delete'], url_path='remove-rows')
    def remove_rows(self, request):
        # Delete all matching rows in one SQL statement.
        deleted_count, _ = Employee.objects.filter(pk__in=request.data).delete()
        return Response({'deleted': deleted_count})
