from django.urls import include, path
from rest_framework.routers import DefaultRouter
from .views import EmployeeViewSet

# DefaultRouter generates all standard and custom-action URLs automatically:
#   GET    /api/employees/                -> list
#   POST   /api/employees/create-rows/   -> create_rows (batch)
#   PATCH  /api/employees/update-rows/   -> update_rows (batch)
#   DELETE /api/employees/remove-rows/   -> remove_rows (batch)

router = DefaultRouter()
router.register(r'employees', EmployeeViewSet, basename='employee')

urlpatterns = [
    path('api/', include(router.urls)),
]
