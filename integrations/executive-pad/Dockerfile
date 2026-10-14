# Optional research-grade PAD adapter, NOT a certified anti-spoofing service.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /opt/executive-pad
COPY integrations/executive-pad/requirements.txt /opt/executive-pad/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY integrations/executive-pad/engine.py /opt/executive-pad/engine.py
RUN useradd -r -u 10041 facepad
USER facepad
EXPOSE 8092
CMD ["python", "engine.py"]
