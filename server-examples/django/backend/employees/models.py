from django.db import models


class Employee(models.Model):
    first_name = models.CharField(max_length=100)
    last_name  = models.CharField(max_length=100)
    department = models.CharField(max_length=100)
    role       = models.CharField(max_length=100)
    # DecimalField avoids floating-point rounding errors for currency values.
    salary     = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        ordering = ['last_name', 'first_name']

    def __str__(self):
        return f'{self.first_name} {self.last_name} ({self.department})'
