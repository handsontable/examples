from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class EmployeePagination(PageNumberPagination):
    page_size = 10
    # Match Handsontable's default query param name so no URL translation is needed.
    page_size_query_param = 'pageSize'
    max_page_size = 100

    def get_paginated_response(self, data):
        # Map DRF's { count, results } to the shape dataProvider expects: { rows, totalRows }.
        return Response({
            'rows': data,
            'totalRows': self.page.paginator.count,
        })

    def get_paginated_response_schema(self, schema):
        return {
            'type': 'object',
            'properties': {
                'rows': schema,
                'totalRows': {'type': 'integer'},
            },
        }
